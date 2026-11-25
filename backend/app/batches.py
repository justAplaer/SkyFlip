"""Durable asynchronous image batches, built on the Part 2 image pipeline."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict

from .observations.db import connect, migrate, utc_now_iso

router = APIRouter(prefix="/api/batches", tags=["Persistent batches"])
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="skyflip-batch")
lock = threading.Lock()
log = logging.getLogger(__name__)


class BatchRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    fov: float = Field(default=0.2, gt=0, le=1)
    detector: int = Field(default=1, ge=1, le=6)
    view_mode: Literal["target_crop", "full_frame"] = "target_crop"
    target: str = Field(default="", max_length=80)
    name: str = Field(default="", max_length=200)
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=8, max_length=128)


def initialize():
    with closing(connect()) as conn, conn:
        migrate(conn)
        conn.execute("""CREATE TABLE IF NOT EXISTS image_batches (
            batch_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
            field_key TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
            request_json TEXT NOT NULL, result_json TEXT NOT NULL,
            next_offset INTEGER NOT NULL DEFAULT 0)""")
        conn.execute("CREATE INDEX IF NOT EXISTS batches_field ON image_batches(field_key,created_at)")


def recover_interrupted():
    initialize()
    with closing(connect()) as conn, conn:
        rows = conn.execute("SELECT batch_id,result_json FROM image_batches WHERE status IN ('queued','running')").fetchall()
        for row in rows:
            result = json.loads(row['result_json'])
            result['status'] = 'partial' if result.get('data', {}).get('frames') else 'failed'
            result['error'] = {'kind': 'interrupted', 'message': 'Server restarted during retrieval. Saved frames are preserved; request a new batch to continue.'}
            conn.execute("UPDATE image_batches SET status=?,result_json=? WHERE batch_id=?", (result['status'], json.dumps(result), row['batch_id']))


def get_batch(batch_id: str) -> dict:
    initialize()
    with closing(connect()) as conn, conn:
        row = conn.execute("SELECT result_json FROM image_batches WHERE batch_id=?", (batch_id,)).fetchone()
    if not row:
        raise HTTPException(404, detail={'kind': 'batch_not_found', 'message': 'Batch does not exist.'})
    return json.loads(row[0])


def save(result):
    with closing(connect()) as conn, conn:
        conn.execute("UPDATE image_batches SET status=?,result_json=?,next_offset=? WHERE batch_id=?", (result['status'], json.dumps(result, allow_nan=False), result['next_offset'], result['batch_id']))


@router.get("")
def list_batches(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    initialize()
    with closing(connect()) as conn, conn:
        rows = conn.execute("SELECT result_json FROM image_batches ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    return {'batches': [json.loads(r[0]) for r in rows]}


@router.get("/{batch_id}")
def retrieve_batch(batch_id: str):
    return get_batch(batch_id)


@router.get("/{batch_id}/frames/{index}")
def frame_metadata(batch_id: str, index: int):
    frames = get_batch(batch_id)['data']['frames']
    if not 0 <= index < len(frames):
        raise HTTPException(404, 'Frame does not exist in this batch.')
    return frames[index]


@router.post("", status_code=202)
def create_batch(req: BatchRequest):
    initialize()
    field_key = hashlib.sha256(json.dumps([req.ra, req.dec, req.fov, req.detector, req.view_mode]).encode()).hexdigest()
    with lock, closing(connect()) as conn, conn:
        previous = conn.execute("SELECT request_json,result_json FROM image_batches WHERE request_key=?", (req.idempotency_key,)).fetchone()
        if previous:
            if json.loads(previous[0]) != req.model_dump():
                raise HTTPException(409, 'Idempotency key already belongs to another request.')
            return json.loads(previous[1])
        active = conn.execute("SELECT COUNT(*) FROM image_batches WHERE status IN ('queued','running')").fetchone()[0]
        if active >= 4:
            raise HTTPException(429, 'Four batches are already queued. Wait for them to complete.')
        if conn.execute("SELECT 1 FROM image_batches WHERE field_key=? AND status IN ('queued','running')", (field_key,)).fetchone():
            raise HTTPException(409, 'A batch for this field and mode is already running.')
        offset = conn.execute("SELECT COALESCE(MAX(next_offset),0) FROM image_batches WHERE field_key=?", (field_key,)).fetchone()[0]
        result = dict(batch_id=str(uuid.uuid4()), created_at=utc_now_iso(), status='queued',
                      request=req.model_dump(), next_offset=offset, image_count=0, requested_count=10,
                      warnings=[], failures=[], data=dict(ra=req.ra, dec=req.dec, fov_deg=req.fov,
                      stack='none', source='live', frames=[], pixel_scale_arcsec=6.15,
                      view_mode=req.view_mode, subtract_zodi=False), error=None)
        conn.execute("INSERT INTO image_batches VALUES (?,?,?,?,?,?,?,?)", (result['batch_id'], req.idempotency_key, field_key, result['created_at'], 'queued', req.model_dump_json(), json.dumps(result), offset))
        conn.commit()
        executor.submit(build_batch, result['batch_id'])
    return result


def build_batch(batch_id: str):
    # Imports here keep image construction reusable without a circular app import.
    from . import main
    from .adapters.spherex import SpherexAdapter
    from .imaging import Frame, align_frames
    from .models import CutoutFrameMeta
    result = get_batch(batch_id)
    req = BatchRequest(**result['request'])
    result['status'] = 'running'
    save(result)
    deadline = time.monotonic() + float(os.environ.get('SKYFLIP_BATCH_TIMEOUT', '300'))
    adapter = SpherexAdapter(timeout=float(os.environ.get('SKYFLIP_HTTP_TIMEOUT', '30')))
    frames = result['data']['frames']
    reference = None
    try:
        obs = adapter.find_observations(req.ra, req.dec, fov_deg=req.fov, bandpasses=(f'SPHEREx-D{req.detector}',), max_rows=10000)
        # Exclude previously saved observations even if upstream ordering changed.
        with closing(connect()) as conn, conn:
            records = conn.execute("SELECT result_json FROM image_batches WHERE field_key=(SELECT field_key FROM image_batches WHERE batch_id=?) AND batch_id<>?", (batch_id,batch_id)).fetchall()
        used = {f['epoch_id'] for r in records for f in json.loads(r[0])['data']['frames']}
        # A cursor is informational; identity exclusion protects against inserted archive rows.
        candidates = [o for o in obs if f'{o.obs_id}|{o.bandpass}|{o.mjd}' not in used]
        result['available_observations'] = len(candidates)
        result['selected_observations'] = [o.to_dict() for o in candidates[:40]]
        save(result)
        for o in candidates[:40]:
            if len(frames) == 10 or time.monotonic() >= deadline:
                break
            result['next_offset'] += 1
            try:
                eid = f'{o.obs_id}|{o.bandpass}|{o.mjd}'
                common = dict(epoch_id=eid, obs_id=o.obs_id, mjd=o.mjd, time_iso=o.time_iso,
                              bandpass=o.bandpass, detector=o.detector, collection=o.collection,
                              source_url=o.access_url, view_mode=req.view_mode, image_url='')
                if req.view_mode == 'full_frame':
                    meta = main._ensure_frame_pyramid(o, subtract_zodi=False, target_ra=req.ra, target_dec=req.dec)
                    frame = CutoutFrameMeta(**common, array_shape=meta['shape'], wcs=meta['wcs'],
                        bunit=meta.get('bunit', 'MJy/sr'), target_x_pix=meta.get('target_x_pix'),
                        target_y_pix=meta.get('target_y_pix'), central_wavelength_um=meta.get('central_wavelength_um'),
                        frame_meta_url=f'/api/frame/{o.obs_id}/{o.detector}/meta?subtract_zodi=false',
                        stretch_hint=meta.get('stats', {})).model_dump(mode='json')
                else:
                    cut = adapter.fetch_cutout(o, center_ra=req.ra, center_dec=req.dec, size_deg=req.fov)
                    if not np.isfinite(cut.image).any():
                        raise ValueError('No finite science pixels in this cutout.')
                    if reference is None:
                        reference = Frame(cut.image, cut.wcs)
                    img = align_frames([Frame(cut.image,cut.wcs)], reference)[0]
                    if not np.isfinite(img).any():
                        raise ValueError('No overlap with the first batch image.')
                    png = main._store_png(img, f'batch_{batch_id}_{len(frames)}', 'asinh')
                    common['image_url'] = f'/api/png/{png}'
                    common['source_url'] = o.cutout_url or o.access_url
                    tx,ty = main._target_xy_from_wcs(reference.wcs, req.ra, req.dec)
                    frame = CutoutFrameMeta(**common, wcs=main._wcs_dict(reference.wcs),
                        array_shape=list(img.shape), target_x_pix=tx, target_y_pix=ty,
                        flag_summary=cut.flag_summary, central_wavelength_um=cut.central_wavelength_um,
                        bunit=str(cut.header_meta.get('BUNIT') or 'MJy/sr')).model_dump(mode='json')
                frames.append(frame)
                result['image_count'] = len(frames)
            except Exception as exc:
                log.warning('Batch %s skipped %s: %s',batch_id,o.obs_id,exc)
                result['failures'].append({'obs_id':o.obs_id,'message':str(exc)[:500]})
            save(result)
        frames.sort(key=lambda f: (f['mjd'],f['epoch_id']))
        result['status'] = 'ready' if len(frames)==10 else 'partial' if frames else 'failed'
        if len(frames) < 10:
            result['warnings'].append(f'Preserved {len(frames)} of 10 requested images. Archive coverage, failed downloads, or the request time/40-candidate limit prevented a complete batch.')
        if not frames:
            result['error'] = {'kind': 'external_data', 'message': 'No usable images retrieved. See failures and retry when the archive is available.'}
    except Exception as exc:
        log.exception('Batch %s failed',batch_id)
        result['status'] = 'partial' if frames else 'failed'
        result['error'] = {'kind':'external_data', 'message':str(exc)[:1000]}
    result['data']['note'] = '; '.join(result['warnings']) or 'Chronological archive images. Detector wavelengths can vary; blinking changes are candidates, not confirmed motion.'
    result['completed_at'] = utc_now_iso()
    save(result)
