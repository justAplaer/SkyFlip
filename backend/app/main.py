"""SkyFlip FastAPI application."""

from __future__ import annotations

import io
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time
import astropy.units as u
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, FileResponse
from PIL import Image
from astropy.wcs import WCS

from .adapters import catalogs, spherex
from .adapters.spherex import PIXEL_SCALE_ARCSEC
from .cache import DEMO_DATA, demo_data_available, read_json, write_json, cache_root
from .classify import classify_track
from . import crossmatch as crossmatch_mod
from .detect import detect_sources, link_detections
from .imaging import Frame, align_frames, difference, stretch, stack_mean
from .sky_match import manifest_center_match, positions_match
from .models import (
    Classification,
    CutoutFrameMeta,
    CutoutsResponse,
    DataSource,
    DiffResponse,
    EpochInfo,
    EpochsFullResponse,
    EpochsResponse,
    FramePyramidMeta,
    FullEpochFrame,
    HealthResponse,
    HealthServiceStatus,
    MoverCandidate,
    MoversResponse,
    MoverTrackPoint,
    PixelInspectorResponse,
    PredictedTrackResponse,
    ResolveResponse,
    ScoreboardResponse,
    ChangeScoreFrame,
    ChangeScoresResponse,
    SpectrumPoint,
    SpectrumResponse,
)
from . import change_scores, frame_pyramid, predicted_track as predicted_track_mod, spectra, validate
from . import time_track as time_track_mod, motion_speed as motion_speed_mod
from .models import TimeTrackResponse, TimeTrackPoint, TimeTrackKeyDate, MotionSpeedResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("skyflip")

ROOT = Path(__file__).resolve().parents[2]
SCOREBOARD_PATH = ROOT / "frontend" / "public" / "demo-data" / "scoreboard.json"
VOTES_DB = cache_root() / "votes.sqlite3"

app = FastAPI(
    title="SkyFlip API",
    version="0.2.0",
    description="Blink comparator for NASA SPHEREx. Candidates only — we do not claim Planet X discoveries.",
)


def _cors_allow_origins() -> list[str]:
    """Comma-separated allowlist from SKYFLIP_CORS_ORIGINS. Never \"*\"."""
    raw = (os.environ.get("SKYFLIP_CORS_ORIGINS") or "").strip()
    if not raw:
        # Local-dev default only — production must set the env allowlist.
        return [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if any(o == "*" for o in origins):
        raise RuntimeError("SKYFLIP_CORS_ORIGINS must not contain '*'")
    return origins


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Discover via SIA: spherex_dr1, spherex_dr1_deep, spherex_qr3, spherex_qr3_deep
adapter = spherex.SpherexAdapter(include_deep=True)

# Sky positions for API helpers — prefer demo cutout CRVAL when available.
TEST_TARGETS = {t["id"]:t for t in json.loads((ROOT / "frontend/src/data/targets.json").read_text(encoding="utf-8"))}


def _array_to_png_bytes(data: np.ndarray, mode: str = "asinh") -> bytes:
    scaled = stretch(data, mode=mode)
    img8 = (scaled * 255).astype(np.uint8)
    im = Image.fromarray(img8, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _demo_manifest(target_id: str) -> Optional[dict[str, Any]]:
    path = DEMO_DATA / target_id / "manifest.json"
    if path.exists():
        return read_json(path)
    return None


def _wcs_dict(wcs) -> dict[str, Any]:
    try:
        return dict(wcs.to_header())
    except Exception:
        return {}


def _service_unavailable(endpoint: str, detail: str, *, source: str = "error") -> JSONResponse:
    """CORS-safe 503 JSON — never let offline archive failures white-screen the UI."""
    return JSONResponse(
        status_code=503,
        content={
            "detail": detail,
            "source": source,
            "endpoint": endpoint,
            "ok": False,
        },
    )


def _tan_wcs(ra: float, dec: float, shape: tuple[int, int], pixel_scale_arcsec: float = PIXEL_SCALE_ARCSEC) -> WCS:
    ny, nx = shape
    w = WCS(naxis=2)
    w.wcs.crpix = [nx / 2.0, ny / 2.0]
    scale = pixel_scale_arcsec / 3600.0
    w.wcs.cdelt = [-scale, scale]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def _cached_predicted_track(name: str) -> Optional[dict[str, Any]]:
    needle = name.lower()
    for tid, meta in TEST_TARGETS.items():
        if tid in needle or meta["name"].lower() in needle or needle in meta["name"].lower():
            path = DEMO_DATA / tid / "predicted_track.json"
            if path.exists():
                return read_json(path)
    return None


@app.get("/api/health", response_model=HealthResponse)
def health(deep: bool = Query(False, description="If true, ping IRSA/SIMBAD/JPL (slow)")) -> HealthResponse:
    # Fast default so the UI never blocks on external archives.
    if not deep:
        return HealthResponse(
            status="ok",
            source=DataSource.live,
            services={
                "irsa": HealthServiceStatus(ok=True, detail="skipped (pass deep=1 to probe)"),
                "simbad": HealthServiceStatus(ok=True, detail="skipped (pass deep=1 to probe)"),
                "jpl": HealthServiceStatus(ok=True, detail="skipped (pass deep=1 to probe)"),
            },
            demo_cache_available=demo_data_available(),
            pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
        )
    irsa = adapter.ping_irsa()
    simbad = catalogs.ping_simbad()
    jpl = catalogs.ping_jpl()
    services = {
        "irsa": HealthServiceStatus(ok=bool(irsa.get("ok")), detail=str(irsa)[:300]),
        "simbad": HealthServiceStatus(ok=bool(simbad.get("ok")), detail=str(simbad)[:300]),
        "jpl": HealthServiceStatus(ok=bool(jpl.get("ok")), detail=str(jpl)[:300]),
    }
    oks = [s.ok for s in services.values()]
    status = "ok" if all(oks) else ("degraded" if any(oks) else "down")
    return HealthResponse(
        status=status,
        source=DataSource.live,
        services=services,
        demo_cache_available=demo_data_available(),
        pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
    )


@app.get("/api/targets")
def targets() -> dict[str, Any]:
    return {"targets": list(TEST_TARGETS.values()), "source": "live"}


@app.get("/api/resolve", response_model=ResolveResponse)
def resolve(name: str = Query(..., min_length=1)) -> ResolveResponse:
    try:
        data = catalogs.resolve_name(name)
    except catalogs.CatalogAdapterError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Resolve error: {exc}") from exc
    return ResolveResponse(**data)


@app.get("/api/epochs", response_model=EpochsResponse)
def epochs(
    ra: float = Query(...),
    dec: float = Query(...),
    fov: float = Query(0.15, gt=0, le=2.0),
    bandpass: Optional[str] = None,
    target: Optional[str] = None,
) -> EpochsResponse:
    bands = (bandpass,) if bandpass else ("SPHEREx-D1",)
    try:
        obs = adapter.find_observations(
            ra, dec, fov_deg=fov, bandpasses=bands, prefer="sia"
        )
        source = DataSource.live
    except Exception as exc:
        logger.warning("live epochs failed: %s", exc)
        obs = []
        source = DataSource.cached_demo

    if not obs and target:
        man = _demo_manifest(target)
        if man and manifest_center_match(ra, dec, man):
            epochs_out = [
                EpochInfo(
                    epoch_id=f["epoch_id"],
                    obs_id=f.get("obs_id", f["epoch_id"]),
                    mjd=f["mjd"],
                    time_iso=f.get("time_iso", ""),
                    bandpass=f.get("bandpass", "SPHEREx-D1"),
                    detector=f.get("detector", 1),
                    collection=f.get("collection", ""),
                    central_wavelength_um=f.get("central_wavelength_um"),
                    flag_summary=f.get("flag_summary", {}),
                )
                for f in man.get("frames", [])
            ]
            return EpochsResponse(
                ra=ra, dec=dec, fov_deg=fov, epochs=epochs_out, source=DataSource.cached_demo
            )

    epochs_out = [
        EpochInfo(
            epoch_id=f"{o.obs_id}|{o.bandpass}|{o.mjd}",
            obs_id=o.obs_id,
            mjd=o.mjd,
            time_iso=o.time_iso,
            bandpass=o.bandpass,
            detector=o.detector,
            collection=o.collection,
            cutout_url=o.cutout_url,
            s_pixel_scale_arcsec=o.s_pixel_scale_arcsec,
        )
        for o in obs
    ]
    return EpochsResponse(ra=ra, dec=dec, fov_deg=fov, epochs=epochs_out, source=source)


def _select_blink_epochs(
    obs_list: list,
    max_frames: int = 8,
    *,
    wavelength_tol_um: Optional[float] = None,
    ref_wavelength_um: Optional[float] = None,
) -> list:
    """Pick well-spaced epochs for blinking (prefer distinct nights)."""
    if not obs_list:
        return []
    obs_list = sorted(obs_list, key=lambda o: o.mjd)
    by_day: dict[int, Any] = {}
    for o in obs_list:
        day = int(o.mjd)
        by_day.setdefault(day, o)
    days = sorted(by_day)
    chosen = [by_day[d] for d in days]
    if len(chosen) > max_frames:
        idxs = np.linspace(0, len(chosen) - 1, max_frames).astype(int)
        chosen = [chosen[i] for i in idxs]
    return chosen


DEFAULT_DETECTOR_BY_TARGET = {
    # Verified band ranges in docs/DATA_NOTES.md (Explanatory Supplement / Data Products).
    # Cold brown dwarfs peak mid-IR → prefer D5/D6; bright stars OK on D1.
    "wise0855": "SPHEREx-D5",
    "epsilon_indi_b": "SPHEREx-D5",
    "barnards_star": "SPHEREx-D1",
    "rw_aurigae": "SPHEREx-D1",
    "r_draconis": "SPHEREx-D1",
}


def _target_xy_from_wcs(wcs: WCS, ra: float, dec: float) -> tuple[Optional[float], Optional[float]]:
    try:
        coord = SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
        x, y = wcs.world_to_pixel(coord)
        return float(x), float(y)
    except Exception:
        return None, None


def _ensure_frame_pyramid(
    observation: spherex.SpherexObservation,
    *,
    subtract_zodi: bool,
    target_ra: float | None = None,
    target_dec: float | None = None,
) -> dict[str, Any]:
    """Download full MEF once, build tile pyramid, return meta dict."""
    root = cache_root()
    if frame_pyramid.pyramid_ready(
        root, observation.obs_id, observation.detector, subtract_zodi=subtract_zodi
    ):
        meta = frame_pyramid.load_meta(
            root, observation.obs_id, observation.detector, subtract_zodi=subtract_zodi
        )
        if meta:
            return meta
    # Drop stale cutout-sized pyramids left by an older download fallback.
    frame_pyramid.clear_pyramid(
        root, observation.obs_id, observation.detector, subtract_zodi=subtract_zodi
    )

    cut = adapter.fetch_full_frame(
        observation,
        subtract_zodi=subtract_zodi,
        target_ra=target_ra,
        target_dec=target_dec,
        allow_cutout_fallback=False,
    )
    ny, nx = cut.image.shape
    if not frame_pyramid.is_full_detector_shape(ny, nx):
        raise RuntimeError(
            f"Full-frame pyramid for {observation.obs_id} is {nx}×{ny}; "
            f"expected a ≥{frame_pyramid.MIN_FULL_DETECTOR_SIDE}px detector "
            "(refusing to cache a cutout as full_frame)."
        )
    n_levels = frame_pyramid.num_levels(ny, nx)
    stats = frame_pyramid.robust_stats(cut.image)
    source_url = adapter.full_frame_url(observation)
    wcs_header = _wcs_dict(cut.wcs)
    meta_obj = frame_pyramid.PyramidMeta(
        obs_id=observation.obs_id,
        detector=int(observation.detector),
        shape=(ny, nx),
        tile_size=frame_pyramid.TILE_SIZE,
        n_levels=n_levels,
        subtract_zodi=subtract_zodi,
        bunit=str(cut.header_meta.get("BUNIT") or "MJy/sr"),
        source_url=source_url,
        mjd=float(observation.mjd),
        time_iso=observation.time_iso or str(cut.header_meta.get("DATE-OBS") or ""),
        bandpass=observation.bandpass,
        wcs_header=wcs_header,
        stats=stats,
        central_wavelength_um=cut.central_wavelength_um,
        bandwidth_um=cut.bandwidth_um,
        collection=observation.collection,
    )
    frame_pyramid.write_pyramid(
        root,
        obs_id=observation.obs_id,
        detector=int(observation.detector),
        image=cut.image,
        flags=cut.flags,
        subtract_zodi=subtract_zodi,
        meta=meta_obj,
    )
    out = meta_obj.to_dict()
    if target_ra is not None and target_dec is not None:
        tx, ty = _target_xy_from_wcs(cut.wcs, target_ra, target_dec)
        out["target_x_pix"] = tx
        out["target_y_pix"] = ty
    return out


def _select_batch(observations, offset: int):
    """Select a complete, non-overlapping page from time-ordered observations."""
    chosen = observations[offset:offset + 10]
    if len(chosen) != 10:
        raise HTTPException(status_code=404, detail=f"Only {len(chosen)} more observations are available for this field and detector; a batch needs 10.")
    return chosen


@app.get("/api/cutouts", response_model=CutoutsResponse)
def cutouts(
    ra: float,
    dec: float,
    fov: float = Query(0.2, gt=0, le=1.0),
    stack: Literal["none", "detector", "all_detectors", "date"] = "none",
    bandpass: Optional[str] = None,
    detector: Optional[int] = Query(None, ge=1, le=6),
    stretch_mode: str = "asinh",
    max_frames: int = Query(6, ge=1, le=12),
    batch_offset: Optional[int] = Query(None, ge=0),
    target: Optional[str] = None,
    target_name: Optional[str] = None,
    targeting_mode: Literal["fixed_sky", "track_target"] = "fixed_sky",
    wavelength_tol_um: Optional[float] = Query(
        None, description="Keep frames within ±X µm of the first frame's λ"
    ),
    median_subtract: bool = False,
    subtract_zodi: bool = Query(
        False,
        description="If true, subtract ZODI extension from IMAGE (default: raw IMAGE).",
    ),
    view_mode: Literal["full_frame", "target_crop"] = Query(
        "target_crop",
        description="target_crop = IBE cutout (legacy); full_frame = whole detector via tile pyramid.",
    ),
) -> CutoutsResponse:
    frames_meta: list[CutoutFrameMeta] = []
    source = DataSource.live
    note_bits: list[str] = []
    live_fail_exc: Exception | None = None

    if bandpass is None:
        if detector is not None:
            bandpass = f"SPHEREx-D{detector}"
        elif target and target in DEFAULT_DETECTOR_BY_TARGET:
            bandpass = DEFAULT_DETECTOR_BY_TARGET[target]
        else:
            bandpass = "SPHEREx-D1"

    # Fixed-sky: one center for all epochs (movers hop). Track-target: each cutout
    # centered on PM-propagated position (target stays near crosshair).
    pm = None
    name_for_pm = target_name or (TEST_TARGETS.get(target or "", {}) or {}).get("name") or ""
    if targeting_mode == "track_target" or name_for_pm:
        try:
            pm = catalogs.get_proper_motion(name_for_pm or "target", ra, dec)
            note_bits.append(f"PM: {pm['citation']} ({pm['uncertainty_note']})")
        except Exception as exc:
            logger.info("PM lookup skipped: %s", exc)

    try:
        bandpasses: tuple[str, ...]
        if stack == "all_detectors":
            bandpasses = tuple(f"SPHEREx-D{i}" for i in range(1, 7))
        else:
            bandpasses = (bandpass,)

        obs = adapter.find_observations(
            ra, dec, fov_deg=fov, bandpasses=bandpasses, prefer="sia",
            max_rows=1000000 if batch_offset is not None else 500,
        )
        if batch_offset is not None:
            chosen = _select_batch(obs, batch_offset)
        else:
            chosen = _select_blink_epochs(obs, max_frames=max_frames)
        # Fixed-sky: one CRVAL for all frames. For high-PM targets, propagate the
        # catalog position to mid-span SPHEREx MJD (do not use Gaia J2016 as center).
        fixed_cra, fixed_cdec = ra, dec
        if (
            targeting_mode == "fixed_sky"
            and pm is not None
            and chosen
            and catalogs.significant_proper_motion(pm)
        ):
            mjd_ref = 0.5 * (float(chosen[0].mjd) + float(chosen[-1].mjd))
            fixed_cra, fixed_cdec, center_note = catalogs.fixed_sky_cutout_center(
                ra, dec, pm, mjd_ref
            )
            note_bits.append(center_note)
        note_bits.append(f"targeting_mode={targeting_mode}")
        note_bits.append(f"subtract_zodi={subtract_zodi}")
        note_bits.append(f"view_mode={view_mode}")

        if view_mode == "full_frame":
            # Whole-detector pyramids — no IBE cutout; ZODI off by default.
            for o in chosen:
                if targeting_mode == "track_target" and pm is not None:
                    cra, cdec = catalogs.propagate_position(
                        ra, dec, pm, Time(o.mjd, format="mjd")
                    )
                else:
                    cra, cdec = fixed_cra, fixed_cdec
                try:
                    meta = _ensure_frame_pyramid(
                        o, subtract_zodi=subtract_zodi, target_ra=cra, target_dec=cdec
                    )
                except Exception as exc:
                    logger.warning(
                        "skipping full-frame epoch %s: %s", o.obs_id, exc
                    )
                    note_bits.append(f"skipped {o.obs_id} (full frame unavailable)")
                    continue
                tx = meta.get("target_x_pix")
                ty = meta.get("target_y_pix")
                if tx is None or ty is None:
                    # Recompute from cached WCS header if needed
                    try:
                        w = WCS(meta.get("wcs") or {})
                        tx, ty = _target_xy_from_wcs(w, cra, cdec)
                    except Exception:
                        tx, ty = None, None
                eid = f"{o.obs_id}|{o.bandpass}|{o.mjd}"
                shape = meta.get("shape") or [meta.get("naxis2"), meta.get("naxis1")]
                frames_meta.append(
                    CutoutFrameMeta(
                        epoch_id=eid,
                        obs_id=o.obs_id,
                        mjd=o.mjd,
                        time_iso=o.time_iso,
                        bandpass=o.bandpass,
                        detector=o.detector,
                        image_url="",  # tiled via /api/frame/.../tile
                        central_wavelength_um=meta.get("central_wavelength_um"),
                        flag_summary={},
                        wcs=meta.get("wcs") or {},
                        bunit=str(meta.get("bunit") or "MJy/sr"),
                        source_url=meta.get("source_url") or adapter.full_frame_url(o),
                        array_shape=[int(shape[0]), int(shape[1])],
                        target_x_pix=tx,
                        target_y_pix=ty,
                        subtract_zodi=subtract_zodi,
                        view_mode="full_frame",
                        frame_meta_url=(
                            f"/api/frame/{o.obs_id}/{o.detector}/meta"
                            f"?subtract_zodi={'true' if subtract_zodi else 'false'}"
                        ),
                        stretch_hint={
                            "p01": float((meta.get("stats") or {}).get("p01") or 0),
                            "p50": float((meta.get("stats") or {}).get("p50") or 0),
                            "p995": float((meta.get("stats") or {}).get("p995") or 0),
                        },
                    )
                )
        else:
            cut_objs = []
            for o in chosen:
                if targeting_mode == "track_target" and pm is not None:
                    cra, cdec = catalogs.propagate_position(
                        ra, dec, pm, Time(o.mjd, format="mjd")
                    )
                else:
                    cra, cdec = fixed_cra, fixed_cdec
                cut = adapter.fetch_cutout(
                    o,
                    subtract_zodi=subtract_zodi,
                    center_ra=cra,
                    center_dec=cdec,
                    size_deg=fov,
                )
                cut = adapter.parse_cutout_fits(
                    cut.fits_path,
                    o,
                    subtract_zodi=subtract_zodi,
                    target_ra=cra,
                    target_dec=cdec,
                )
                cut_objs.append(cut)

            # Wavelength match filter (after we know central λ)
            from .change_scores import DEFAULT_WAVELENGTH_TOL_UM

            stack_needs_lambda = stack in ("detector", "all_detectors")
            effective_tol = wavelength_tol_um
            if stack_needs_lambda and effective_tol is None:
                effective_tol = DEFAULT_WAVELENGTH_TOL_UM
            if effective_tol is not None and cut_objs:
                ref_l = cut_objs[0].central_wavelength_um
                if ref_l is not None:
                    kept = [
                        c
                        for c in cut_objs
                        if c.central_wavelength_um is None
                        or abs(c.central_wavelength_um - ref_l) <= effective_tol
                    ]
                    if len(kept) >= 2:
                        cut_objs = kept
                        note_bits.append(
                            f"wavelength match ±{effective_tol} µm around {ref_l:.3f} µm"
                        )
                    elif stack_needs_lambda:
                        note_bits.append(
                            f"wavelength match ±{effective_tol} µm left <2 frames — "
                            "refusing science stack (too few wavelength-matched frames)"
                        )
                        cut_objs = []
                    else:
                        note_bits.append(
                            f"wavelength match ±{effective_tol} µm left <2 frames; "
                            "kept all for blink display only (not a science stack)"
                        )

            if stack in ("detector", "all_detectors") and cut_objs:
                if stack == "all_detectors":
                    note_bits.append(
                        "stack=all_detectors is SED/display-only — detectors span "
                        "incompatible LVF bands; do not treat as motion science"
                    )
                aligned = align_frames(
                    [
                        Frame(c.image, c.wcs, c.variance, c.flags, c.observation.mjd)
                        for c in cut_objs
                    ]
                )
                stacked = stack_mean(aligned)
                png_name = _store_png(stacked, f"stack_{ra:.5f}_{dec:.5f}", stretch_mode)
                frames_meta.append(
                    CutoutFrameMeta(
                        epoch_id="stack",
                        obs_id="stack",
                        mjd=float(np.mean([c.observation.mjd for c in cut_objs])),
                        time_iso="stacked",
                        bandpass=bandpass if stack == "detector" else "SPHEREx-D1..D6",
                        detector=cut_objs[0].observation.detector,
                        image_url=f"/api/png/{png_name}",
                        central_wavelength_um=cut_objs[0].central_wavelength_um,
                        flag_summary={},
                        wcs=_wcs_dict(cut_objs[0].wcs),
                        subtract_zodi=subtract_zodi,
                        view_mode="target_crop",
                    )
                )
                note_bits.append(
                    f"stack={stack} (mean of wavelength-matched aligned frames)"
                    if stack == "detector"
                    else f"stack={stack} (display-only mean)"
                )
            else:
                if cut_objs:
                    ref = Frame(cut_objs[0].image, cut_objs[0].wcs)
                    aligned = align_frames(
                        [Frame(c.image, c.wcs, mjd=c.observation.mjd) for c in cut_objs],
                        ref,
                    )
                else:
                    aligned = []
                if median_subtract and len(aligned) >= 3:
                    med = np.nanmedian(np.stack(aligned, axis=0), axis=0)
                    aligned = [a - med for a in aligned]
                    note_bits.append("median-subtraction mode (static sky removed)")
                for c, img in zip(cut_objs, aligned):
                    eid = f"{c.observation.obs_id}|{c.observation.bandpass}|{c.observation.mjd}"
                    png_name = _store_png(img, eid.replace("|", "_"), stretch_mode)
                    if targeting_mode == "track_target" and pm is not None:
                        sky_ra, sky_dec = catalogs.propagate_position(
                            ra, dec, pm, Time(c.observation.mjd, format="mjd")
                        )
                    else:
                        sky_ra, sky_dec = fixed_cra, fixed_cdec
                    tx, ty = _target_xy_from_wcs(c.wcs, sky_ra, sky_dec)
                    frames_meta.append(
                        CutoutFrameMeta(
                            epoch_id=eid,
                            obs_id=c.observation.obs_id,
                            mjd=c.observation.mjd,
                            time_iso=c.observation.time_iso,
                            bandpass=c.observation.bandpass,
                            detector=c.observation.detector,
                            image_url=f"/api/png/{png_name}",
                            central_wavelength_um=c.central_wavelength_um,
                            flag_summary=c.flag_summary,
                            wcs=_wcs_dict(c.wcs),
                            bunit=str(c.header_meta.get("BUNIT") or "MJy/sr"),
                            source_url=c.observation.cutout_url or c.observation.access_url,
                            array_shape=[int(c.image.shape[0]), int(c.image.shape[1])],
                            target_x_pix=tx,
                            target_y_pix=ty,
                            subtract_zodi=subtract_zodi,
                            view_mode="target_crop",
                        )
                    )
    except Exception as exc:
        if batch_offset is not None:
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(status_code=502, detail=f"Archive batch retrieval failed: {exc}") from exc
        logger.warning("live cutouts failed: %s", exc)
        source = DataSource.cached_demo
        frames_meta = []
        note_bits.append(f"live failed: {exc}")
        live_fail_exc = exc
    else:
        live_fail_exc = None

    if batch_offset is not None and len(frames_meta) != 10:
        raise HTTPException(status_code=502, detail=f"Archive returned {len(frames_meta)} usable images; a batch needs 10. Please try again.")

    if not frames_meta and target:
        man = _demo_manifest(target)
        if man:
            man_ra = float(man.get("ra", float("nan")))
            man_dec = float(man.get("dec", float("nan")))
            # Never serve another field's cached pixels under a different RA/Dec.
            # Accept cutout CRVAL or catalog-epoch coords (high-PM packs differ).
            if not manifest_center_match(ra, dec, man):
                raise HTTPException(
                    status_code=503,
                    detail={
                        "message": "archive returned no observation covering this position",
                        "reason": "no_coverage",
                        "source": "error",
                        "requested_ra": ra,
                        "requested_dec": dec,
                        "cached_target": target,
                        "cached_ra": man_ra,
                        "cached_dec": man_dec,
                        "cached_catalog_ra": man.get("catalog_ra"),
                        "cached_catalog_dec": man.get("catalog_dec"),
                        "note": (
                            "Demo cache is position-locked; free-text searches must not "
                            "reuse another preset's frames."
                        ),
                    },
                )
            source = DataSource.cached_demo
            demo_frames = list(man.get("frames", []))
            if wavelength_tol_um is not None and demo_frames:
                ref_l = demo_frames[0].get("central_wavelength_um")
                if ref_l is not None:
                    filt = [
                        f
                        for f in demo_frames
                        if f.get("central_wavelength_um") is None
                        or abs(float(f["central_wavelength_um"]) - float(ref_l))
                        <= wavelength_tol_um
                    ]
                    if len(filt) >= 2:
                        demo_frames = filt
            for f in demo_frames:
                tx = f.get("predicted_x_pix", f.get("target_x_pix"))
                ty = f.get("predicted_y_pix", f.get("target_y_pix"))
                frames_meta.append(
                    CutoutFrameMeta(
                        epoch_id=f["epoch_id"],
                        obs_id=f.get("obs_id", ""),
                        mjd=f["mjd"],
                        time_iso=f.get("time_iso", ""),
                        bandpass=f.get("bandpass", bandpass),
                        detector=int(f.get("detector", 1)),
                        image_url=f"/demo-data/{target}/{f['png']}",
                        central_wavelength_um=f.get("central_wavelength_um"),
                        flag_summary=f.get("flag_summary", {}),
                        wcs=f.get("wcs", {}),
                        source_url=f.get("cutout_url"),
                        target_x_pix=float(tx) if tx is not None else None,
                        target_y_pix=float(ty) if ty is not None else None,
                        subtract_zodi=False,
                        view_mode="target_crop",
                        array_shape=list(f.get("float_shape") or f.get("image_shape") or [])
                        or None,
                    )
                )
            note_bits.append("cached-demo frames (position match verified)")
            if median_subtract:
                note_bits.append(
                    "median-subtract requested but not applied to pre-stretched demo PNGs"
                )

    if not frames_meta:
        raw = str(live_fail_exc or "").lower()
        if "no covering" in raw or "no observation" in raw or "returned no" in raw:
            msg = "archive returned no observation covering this position"
            reason = "no_coverage"
        elif "outside" in raw and "coverage" in raw:
            msg = "position outside coverage"
            reason = "outside_coverage"
        else:
            msg = "network or archive unreachable"
            reason = "network_unreachable"
        raise HTTPException(
            status_code=503,
            detail={
                "message": msg,
                "reason": reason,
                "source": "error",
                "detail": str(live_fail_exc) if live_fail_exc else None,
            },
        )

    if len(frames_meta) == 1:
        note_bits.append("only one epoch available, blink needs at least 2")
    if not target and not target_name:
        note_bits.append(
            "Custom position — proper motion unknown; fixed sky, no ghost track"
        )

    # Demo packs are always target-crop PNGs — never claim full_frame.
    effective_view = (
        "target_crop" if source == DataSource.cached_demo else view_mode
    )
    # Ensure demo frames have a usable WCS for frontend readout / markers.
    for fm in frames_meta:
        if fm.wcs:
            continue
        shape = fm.array_shape or []
        if len(shape) >= 2:
            ny, nx = int(shape[0]), int(shape[1])
            scale = PIXEL_SCALE_ARCSEC / 3600.0
            fm.wcs = {
                "CRPIX1": (nx + 1) / 2,
                "CRPIX2": (ny + 1) / 2,
                "CRVAL1": ra,
                "CRVAL2": dec,
                "CDELT1": -scale,
                "CDELT2": scale,
                "NAXIS1": nx,
                "NAXIS2": ny,
                "CTYPE1": "RA---TAN",
                "CTYPE2": "DEC--TAN",
            }

    return CutoutsResponse(
        ra=ra,
        dec=dec,
        fov_deg=fov,
        stack=stack,
        frames=frames_meta,
        source=source,
        pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
        subtract_zodi=subtract_zodi,
        view_mode=effective_view,
        note="; ".join(note_bits) if note_bits else None,
    )


@app.get("/api/epochs-full", response_model=EpochsFullResponse)
def epochs_full(
    ra: float,
    dec: float,
    fov: float = Query(0.2, gt=0, le=1.0),
    max_frames: int = Query(6, ge=2, le=12),
    target: Optional[str] = None,
    target_name: Optional[str] = None,
    bandpass: Optional[str] = None,
    detector: Optional[int] = Query(None, ge=1, le=6),
    subtract_zodi: bool = Query(False),
) -> EpochsFullResponse:
    """Blink epochs as full-detector frames with WCS target pixel positions."""
    if bandpass is None:
        if detector is not None:
            bandpass = f"SPHEREx-D{detector}"
        elif target and target in DEFAULT_DETECTOR_BY_TARGET:
            bandpass = DEFAULT_DETECTOR_BY_TARGET[target]
        else:
            bandpass = "SPHEREx-D1"

    frames: list[FullEpochFrame] = []
    source = DataSource.live
    try:
        obs = adapter.find_observations(
            ra, dec, fov_deg=fov, bandpasses=(bandpass,), prefer="sia"
        )
        chosen = _select_blink_epochs(obs, max_frames=max_frames)
        for o in chosen:
            meta = _ensure_frame_pyramid(
                o, subtract_zodi=subtract_zodi, target_ra=ra, target_dec=dec
            )
            tx = meta.get("target_x_pix")
            ty = meta.get("target_y_pix")
            if tx is None or ty is None:
                try:
                    w = WCS(meta.get("wcs") or {})
                    tx, ty = _target_xy_from_wcs(w, ra, dec)
                except Exception:
                    tx, ty = None, None
            shape = meta.get("shape") or [meta.get("naxis2"), meta.get("naxis1")]
            eid = f"{o.obs_id}|{o.bandpass}|{o.mjd}"
            frames.append(
                FullEpochFrame(
                    epoch_id=eid,
                    obs_id=o.obs_id,
                    detector=o.detector,
                    mjd=o.mjd,
                    time_iso=o.time_iso,
                    bandpass=o.bandpass,
                    source_url=meta.get("source_url") or adapter.full_frame_url(o),
                    target_x_pix=tx,
                    target_y_pix=ty,
                    frame_meta_url=(
                        f"/api/frame/{o.obs_id}/{o.detector}/meta"
                        f"?subtract_zodi={'true' if subtract_zodi else 'false'}"
                    ),
                    array_shape=[int(shape[0]), int(shape[1])] if shape[0] else None,
                    subtract_zodi=subtract_zodi,
                    wcs=meta.get("wcs") or {},
                    central_wavelength_um=meta.get("central_wavelength_um"),
                )
            )
    except Exception as exc:
        logger.warning("epochs-full live failed: %s", exc)
        source = DataSource.cached_demo
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"Live full-frame epochs unavailable: {exc}",
                "source": "cached-demo",
                "hint": "Use /api/cutouts?view_mode=target_crop&target=… for offline demo packs.",
            },
        ) from exc

    if not frames:
        raise HTTPException(status_code=404, detail="No epochs found for this position")

    return EpochsFullResponse(
        ra=ra,
        dec=dec,
        frames=frames,
        source=source,
        subtract_zodi=subtract_zodi,
        pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
    )


@app.get("/api/frame/{obs_id}/{detector}/meta", response_model=FramePyramidMeta)
def frame_meta(
    obs_id: str,
    detector: int,
    subtract_zodi: bool = Query(False),
    ra: Optional[float] = None,
    dec: Optional[float] = None,
    access_url: Optional[str] = Query(
        None,
        description="IBE access_url for the MEF (required if pyramid not cached yet)",
    ),
    bandpass: Optional[str] = None,
    mjd: Optional[float] = None,
) -> FramePyramidMeta:
    """Pyramid metadata for one full detector frame (build on demand if needed)."""
    root = cache_root()
    meta = None
    if frame_pyramid.pyramid_ready(root, obs_id, detector, subtract_zodi=subtract_zodi):
        meta = frame_pyramid.load_meta(
            root, obs_id, detector, subtract_zodi=subtract_zodi
        )
    if meta is None:
        if not access_url:
            raise HTTPException(
                status_code=404,
                detail="Frame pyramid not cached; pass access_url to download once.",
            )
        obs = spherex.SpherexObservation(
            obs_id=obs_id,
            bandpass=bandpass or f"SPHEREx-D{detector}",
            detector=detector,
            mjd=float(mjd or 0.0),
            access_url=access_url,
            cutout_url=access_url,
            time_iso="",
            collection=spherex.SpherexAdapter._collection_from_uri(access_url),
        )
        try:
            meta = _ensure_frame_pyramid(
                obs, subtract_zodi=subtract_zodi, target_ra=ra, target_dec=dec
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    # Always recompute target_xy for the request RA/Dec — cached meta may be
    # from a different field that shared the same obs_id.
    if ra is not None and dec is not None:
        try:
            w = WCS(meta.get("wcs") or {})
            tx, ty = _target_xy_from_wcs(w, ra, dec)
            meta["target_x_pix"] = tx
            meta["target_y_pix"] = ty
        except Exception:
            pass
    return FramePyramidMeta(
        obs_id=str(meta["obs_id"]),
        detector=int(meta["detector"]),
        shape=[int(meta["shape"][0]), int(meta["shape"][1])],
        naxis1=int(meta.get("naxis1") or meta["shape"][1]),
        naxis2=int(meta.get("naxis2") or meta["shape"][0]),
        tile_size=int(meta.get("tile_size") or frame_pyramid.TILE_SIZE),
        n_levels=int(meta["n_levels"]),
        subtract_zodi=bool(meta.get("subtract_zodi")),
        bunit=str(meta.get("bunit") or "MJy/sr"),
        source_url=str(meta.get("source_url") or ""),
        mjd=float(meta.get("mjd") or 0.0),
        time_iso=str(meta.get("time_iso") or ""),
        bandpass=str(meta.get("bandpass") or ""),
        wcs=meta.get("wcs") or {},
        stats=meta.get("stats") or {},
        central_wavelength_um=meta.get("central_wavelength_um"),
        bandwidth_um=meta.get("bandwidth_um"),
        collection=str(meta.get("collection") or ""),
        cache_key=str(meta.get("cache_key") or ""),
        units=str(meta.get("bunit") or "MJy/sr"),
        target_x_pix=meta.get("target_x_pix"),
        target_y_pix=meta.get("target_y_pix"),
    )


@app.get("/api/frame/{obs_id}/{detector}/tile/{level}/{ty}/{tx}")
def frame_tile(
    obs_id: str,
    detector: int,
    level: int,
    ty: int,
    tx: int,
    subtract_zodi: bool = Query(False),
) -> Response:
    """Raw float32 LE tile bytes (NaN preserved)."""
    if level < 0 or ty < 0 or tx < 0:
        raise HTTPException(status_code=400, detail="level/ty/tx must be >= 0")
    if not frame_pyramid.pyramid_ready(
        cache_root(), obs_id, detector, subtract_zodi=subtract_zodi
    ):
        raise HTTPException(status_code=404, detail="Frame pyramid not built yet")
    try:
        data = frame_pyramid.read_image_tile(
            cache_root(),
            obs_id,
            detector,
            level,
            ty,
            tx,
            subtract_zodi=subtract_zodi,
        )
    except (FileNotFoundError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/frame/{obs_id}/{detector}/flags/{level}/{ty}/{tx}")
def frame_flags_tile(
    obs_id: str,
    detector: int,
    level: int,
    ty: int,
    tx: int,
    subtract_zodi: bool = Query(False),
) -> Response:
    """Raw int32 LE flag tile bytes (OR-reduced at level > 0)."""
    if level < 0 or ty < 0 or tx < 0:
        raise HTTPException(status_code=400, detail="level/ty/tx must be >= 0")
    if not frame_pyramid.pyramid_ready(
        cache_root(), obs_id, detector, subtract_zodi=subtract_zodi
    ):
        raise HTTPException(status_code=404, detail="Frame pyramid not built yet")
    try:
        data = frame_pyramid.read_flags_tile(
            cache_root(),
            obs_id,
            detector,
            level,
            ty,
            tx,
            subtract_zodi=subtract_zodi,
        )
    except (FileNotFoundError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _store_png(data: np.ndarray, key: str, mode: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in key)[:80]
    name = f"{safe}_{mode}.png"
    path = cache_root() / "png" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_array_to_png_bytes(data, mode=mode))
    return name


@app.get("/api/frame/{obs_id}/{detector}/preview")
def full_frame_preview(obs_id: str, detector: int, subtract_zodi: bool = False):
    """A whole-frame preview for report highlighting, derived from cached science pixels."""
    root = cache_root()
    if not frame_pyramid.pyramid_ready(root, obs_id, detector, subtract_zodi=subtract_zodi):
        raise HTTPException(404, "Full frame is not cached yet.")
    meta = frame_pyramid.load_meta(root, obs_id, detector, subtract_zodi=subtract_zodi)
    level = max(0, int(meta.get("n_levels", 1)) - 1)
    directory = frame_pyramid.pyramid_dir(root, obs_id, detector, subtract_zodi=subtract_zodi) / f"L{level}"
    shape = json.loads((directory / "shape.json").read_text(encoding="utf-8"))
    pixels = np.fromfile(directory / "image.f32", dtype=np.float32).reshape(int(shape["ny"]), int(shape["nx"]))
    return Response(content=_array_to_png_bytes(pixels), media_type="image/png")


@app.get("/api/png/{name}")
def get_png(name: str):
    path = cache_root() / "png" / name
    if not path.exists():
        raise HTTPException(404, "PNG not found")
    return FileResponse(path, media_type="image/png")


@app.get("/api/diff", response_model=DiffResponse)
def diff_images(
    ra: float,
    dec: float,
    fov: float = 0.15,
    a: str = Query(..., description="epoch_id A"),
    b: str = Query(..., description="epoch_id B"),
    bandpass: str = "SPHEREx-D1",
    wavelength_tol_um: float = Query(
        0.03, description="Refuse science diff when |Δλ| exceeds this (µm)"
    ),
):
    try:
        from .change_scores import DEFAULT_WAVELENGTH_TOL_UM

        tol = (
            DEFAULT_WAVELENGTH_TOL_UM
            if wavelength_tol_um is None
            else float(wavelength_tol_um)
        )
        obs = adapter.find_observations(
            ra, dec, fov_deg=fov, bandpasses=(bandpass,), prefer="sia"
        )
        by_id = {f"{o.obs_id}|{o.bandpass}|{o.mjd}": o for o in obs}

        def find(eid: str):
            if eid in by_id:
                return by_id[eid]
            for k, v in by_id.items():
                if eid in k:
                    return v
            return None

        oa, ob = find(a), find(b)
        if not oa or not ob:
            return _service_unavailable(
                "/api/diff",
                "epoch not found or archive unreachable",
                source="error",
            )

        ca = adapter.parse_cutout_fits(
            adapter.fetch_cutout(oa, subtract_zodi=True).fits_path,
            oa,
            subtract_zodi=True,
            target_ra=ra,
            target_dec=dec,
        )
        cb = adapter.parse_cutout_fits(
            adapter.fetch_cutout(ob, subtract_zodi=True).fits_path,
            ob,
            subtract_zodi=True,
            target_ra=ra,
            target_dec=dec,
        )
        la = ca.central_wavelength_um
        lb = cb.central_wavelength_um
        dlam = (
            abs(float(la) - float(lb))
            if la is not None and lb is not None
            else None
        )
        mismatched = dlam is not None and dlam > tol
        if mismatched:
            return DiffResponse(
                ra=ra,
                dec=dec,
                fov_deg=fov,
                epoch_a=a,
                epoch_b=b,
                image_url=None,
                source=DataSource.live,
                note=(
                    f"Wavelength-mismatched (|Δλ|={dlam:.4f} µm > ±{tol} µm) — "
                    "science diff refused; colour ≠ motion"
                ),
                wavelength_a_um=la,
                wavelength_b_um=lb,
                wavelength_diff_um=dlam,
                wavelength_tol_um=tol,
                wavelength_mismatched=True,
                science_ok=False,
            )
        aligned = align_frames([Frame(ca.image, ca.wcs), Frame(cb.image, cb.wcs)])
        diff = difference(aligned[0], aligned[1])
        name = _store_png(diff, f"diff_{a}_{b}", "asinh")
        note = "Difference of aligned cutouts on a common grid."
        if dlam is not None:
            note += f" |Δλ|={dlam:.4f} µm ≤ ±{tol} µm."
        elif la is None or lb is None:
            note += " Wavelength unknown on one/both frames — Δλ not computed."
        return DiffResponse(
            ra=ra,
            dec=dec,
            fov_deg=fov,
            epoch_a=a,
            epoch_b=b,
            image_url=f"/api/png/{name}",
            source=DataSource.live,
            note=note,
            wavelength_a_um=la,
            wavelength_b_um=lb,
            wavelength_diff_um=dlam,
            wavelength_tol_um=tol,
            wavelength_mismatched=False,
            science_ok=True,
        )
    except Exception as exc:
        logger.exception("diff failed")
        return _service_unavailable("/api/diff", f"diff failed: {exc}", source="error")


@app.get("/api/track", response_model=TimeTrackResponse)
def time_track(
    target: str = Query(..., min_length=1, description="Curated target id or name"),
    start: str = Query("2010-01-01", description="ISO date or decimal year"),
    end: str = Query("2035-12-31", description="ISO date or decimal year"),
    n: int = Query(101, ge=2, le=501),
):
    """Dense PM track for the Time machine slider (apply_space_motion).

    Unknown targets → 404. Zero-PM variables → flat track with is_mover=false.
    """
    def _parse_bound(raw: str) -> float:
        s = (raw or "").strip()
        try:
            return float(s)
        except ValueError:
            pass
        try:
            return float(Time(s).decimalyear)
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Invalid date/year {raw!r}: {exc}"
            ) from exc

    try:
        start_y = _parse_bound(start)
        end_y = _parse_bound(end)
        frames = time_track_mod.demo_spherex_frames(target)
        # Also try by resolved target_id after lookup
        from .pm_table import find_target_row

        row = find_target_row(target)
        if row and not frames:
            frames = time_track_mod.demo_spherex_frames(str(row.get("target_id")))
        data = time_track_mod.build_time_track(
            target=target,
            start_year=start_y,
            end_year=end_y,
            n=n,
            spherex_frames=frames,
        )
        ms = data.get("motion_speed")
        return TimeTrackResponse(
            target_id=data.get("target_id"),
            name=data.get("name"),
            is_mover=bool(data.get("is_mover")),
            start_year=float(data["start_year"]),
            end_year=float(data["end_year"]),
            n=int(data["n"]),
            catalog_ra=float(data["catalog_ra"]),
            catalog_dec=float(data["catalog_dec"]),
            ref_epoch=float(data["ref_epoch"]),
            proper_motion=data.get("proper_motion") or {},
            points=[TimeTrackPoint(**p) for p in data.get("points") or []],
            key_dates=[TimeTrackKeyDate(**k) for k in data.get("key_dates") or []],
            motion_speed=MotionSpeedResponse(**ms) if isinstance(ms, dict) else None,
            honesty=str(data.get("honesty") or ""),
            non_mover_message=data.get("non_mover_message"),
            method=str(data.get("method") or ""),
            source=str(data.get("source") or "pm_table"),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("time track failed")
        raise HTTPException(status_code=500, detail=f"track failed: {exc}") from exc


@app.get("/api/motion-speed", response_model=MotionSpeedResponse)
def motion_speed(target: str = Query(..., min_length=1)):
    """Real-world speed / distance from pm_table (parallax only when cited)."""
    try:
        data = motion_speed_mod.motion_speed_for_target(target)
        return MotionSpeedResponse(**data)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/predicted-track", response_model=PredictedTrackResponse)
def predicted_track(
    ra: float,
    dec: float,
    name: str = Query(...),
    bandpass: str = "SPHEREx-D1",
    fov: float = 0.15,
):
    """Historical catalog markers + PM-propagated ghost (apply_space_motion).

    PM for the five demo targets comes from pm_table.json (SSOT). Offline uses
    cached predicted_track.json. Never invents catalog positions.
    """
    try:
        # Prefer demo frames so ghost epoch_ids match the blink player offline.
        demo_frames = None
        cut_ra, cut_dec = ra, dec
        shape = (117, 117)
        for tid, meta in TEST_TARGETS.items():
            if meta["name"].lower() in name.lower() or tid in name.lower().replace(" ", "_"):
                man = _demo_manifest(tid)
                if man:
                    demo_frames = man.get("frames", [])
                    cut_ra = float(man.get("ra", ra))
                    cut_dec = float(man.get("dec", dec))
                    sh = demo_frames[0].get("float_shape") or demo_frames[0].get("image_shape")
                    if sh and len(sh) >= 2:
                        shape = (int(sh[0]), int(sh[1]))
                break

        if demo_frames:
            wcs = _tan_wcs(cut_ra, cut_dec, shape)
            resp = predicted_track_mod.build_predicted_track(
                name=name,
                cutout_ra=cut_ra,
                cutout_dec=cut_dec,
                frames=demo_frames,
                wcs=wcs,
                pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
                source=DataSource.cached_demo,
            )
            return resp

        # Live epoch list when no demo cache match
        epochs = []
        try:
            epochs = adapter.find_observations(
                ra, dec, fov_deg=fov, bandpasses=(bandpass,), prefer="sia"
            )
        except Exception as exc:
            logger.info("predicted-track epoch query failed: %s", exc)

        chosen = _select_blink_epochs(epochs, max_frames=8) if epochs else []
        if chosen:
            npix = max(29, int(round(fov * 3600.0 / PIXEL_SCALE_ARCSEC)))
            wcs = _tan_wcs(ra, dec, (npix, npix))
            frames = [
                {
                    "epoch_id": f"{o.obs_id}|{o.bandpass}|{o.mjd}",
                    "mjd": o.mjd,
                }
                for o in chosen
            ]
            return predicted_track_mod.build_predicted_track(
                name=name,
                cutout_ra=ra,
                cutout_dec=dec,
                frames=frames,
                wcs=wcs,
                pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
                source=DataSource.live,
            )

        cached = _cached_predicted_track(name)
        if cached:
            return predicted_track_mod.response_from_cached_json(cached, name, ra, dec)

        # Last resort: single-point track at input coords
        return predicted_track_mod.build_predicted_track(
            name=name,
            cutout_ra=ra,
            cutout_dec=dec,
            frames=[{"epoch_id": "ref", "mjd": Time.now().mjd}],
            wcs=_tan_wcs(ra, dec, (117, 117)),
            pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
            source=DataSource.live,
        )
    except Exception as exc:
        logger.exception("predicted-track failed")
        cached = _cached_predicted_track(name)
        if cached:
            resp = predicted_track_mod.response_from_cached_json(cached, name, ra, dec)
            resp.method = f"cached fallback after error: {exc}"
            return resp
        return _service_unavailable(
            "/api/predicted-track",
            f"predicted-track failed: {exc}",
            source="error",
        )


@app.get("/api/movers", response_model=MoversResponse)
def movers(
    ra: float,
    dec: float,
    fov: float = 0.15,
    bandpass: str = "SPHEREx-D1",
):
    try:
        obs = adapter.find_observations(
            ra, dec, fov_deg=fov, bandpasses=(bandpass,), prefer="sia"
        )
        chosen = _select_blink_epochs(obs, max_frames=6)
        if not chosen:
            # Offline: empty movers with clear source, not a 500
            cached = DEMO_DATA / "movers_cache.json"
            if cached.exists():
                data = read_json(cached)
                return MoversResponse(
                    ra=ra,
                    dec=dec,
                    fov_deg=fov,
                    movers=[MoverCandidate(**m) for m in data.get("movers", [])],
                    source=DataSource.cached_demo,
                )
            return MoversResponse(
                ra=ra, dec=dec, fov_deg=fov, movers=[], source=DataSource.cached_demo
            )
        per_epoch = []
        for o in chosen:
            cut = adapter.parse_cutout_fits(
                adapter.fetch_cutout(o, subtract_zodi=True).fits_path,
                o,
                subtract_zodi=True,
                target_ra=ra,
                target_dec=dec,
            )
            eid = f"{o.obs_id}|{o.bandpass}|{o.mjd}"
            dets = detect_sources(cut.image, cut.wcs, eid, o.mjd)
            per_epoch.append(dets)
        tracks = link_detections(per_epoch)
        out = []
        for tr in tracks:
            xm = crossmatch_mod.crossmatch_track(tr, prefer_cache=True, allow_live=True)
            cls = classify_track(tr, crossmatch=xm)
            out.append(
                MoverCandidate(
                    id=tr.id,
                    classification=Classification(cls["classification"]),
                    reasons=cls["reasons"],
                    track=[
                        MoverTrackPoint(
                            epoch_id=d.epoch_id,
                            mjd=d.mjd,
                            ra=d.ra,
                            dec=d.dec,
                            ra_err_arcsec=d.x_err * PIXEL_SCALE_ARCSEC,
                            dec_err_arcsec=d.y_err * PIXEL_SCALE_ARCSEC,
                        )
                        for d in tr.detections
                    ],
                    pm_ra_arcsec_yr=tr.pm_ra_arcsec_yr,
                    pm_dec_arcsec_yr=tr.pm_dec_arcsec_yr,
                    pm_ra_err_arcsec_yr=tr.pm_ra_err,
                    pm_dec_err_arcsec_yr=tr.pm_dec_err,
                    crossmatch=cls.get("crossmatch", {}),
                    is_synthetic=tr.is_synthetic,
                )
            )
        return MoversResponse(ra=ra, dec=dec, fov_deg=fov, movers=out, source=DataSource.live)
    except Exception as exc:
        logger.exception("movers failed")
        return _service_unavailable("/api/movers", f"movers failed: {exc}", source="error")


@app.get("/api/spectrum", response_model=SpectrumResponse)
def spectrum(ra: float, dec: float, fov: float = 0.03):
    try:
        data = spectra.extract_spectrum_at(adapter, ra, dec, fov_deg=fov)
        return SpectrumResponse(
            ra=ra,
            dec=dec,
            points=[SpectrumPoint(**p) for p in data["points"]],
            source=DataSource.live,
            unit=data["unit"],
            method_note=data["method_note"] + " Notes: " + "; ".join(data.get("notes", [])),
            is_synthetic=False,
        )
    except Exception as exc:
        logger.exception("spectrum failed")
        # Cached spectrum fallback
        for tid in TEST_TARGETS:
            path = DEMO_DATA / tid / "spectrum.json"
            if path.exists():
                cached = read_json(path)
                return SpectrumResponse(
                    ra=float(cached.get("ra", ra)),
                    dec=float(cached.get("dec", dec)),
                    points=[SpectrumPoint(**p) for p in cached.get("points", [])],
                    source=DataSource.cached_demo,
                    unit=cached.get("unit", "MJy/sr"),
                    method_note=cached.get(
                        "method_note",
                        f"Using cached demo spectrum after live failure: {exc}",
                    ),
                    is_synthetic=bool(cached.get("is_synthetic", False)),
                )
        return _service_unavailable(
            "/api/spectrum",
            f"spectrum failed: {exc}",
            source="error",
        )


def _with_wavelength_meta(
    resp: ChangeScoresResponse,
    *,
    wavelength_tol_um: float,
    scores: list | None = None,
) -> ChangeScoresResponse:
    """Attach λ-tolerance / exclusion counts; gate motion when too few matched."""
    summary = change_scores.wavelength_match_summary(
        scores if scores is not None else resp.frames,
        wavelength_tol_um=wavelength_tol_um,
    )
    resp.wavelength_tol_um = summary["wavelength_tol_um"]
    resp.n_wavelength_excluded = int(summary["n_wavelength_excluded"])
    resp.wavelength_status = summary["wavelength_status"]
    resp.wavelength_message = summary["message"]
    if summary["too_few_wavelength_matched_frames"]:
        resp.motion = {
            "status": "too_few_wavelength_matched_frames",
            "message": "too few wavelength-matched frames",
            "pm_arcsec_yr": None,
            "pm_arcsec_yr_err": None,
        }
    return resp


@app.get("/api/change-scores", response_model=ChangeScoresResponse)
def change_scores_endpoint(
    ra: float = Query(...),
    dec: float = Query(...),
    radius: float = Query(1.5, gt=0.1, le=10.0, description="Aperture radius in SPHEREx pixels"),
    metric: Literal["brightness_snr", "position_shift", "combined"] = "brightness_snr",
    reference: Literal["median_others", "first_epoch", "previous_epoch"] = "median_others",
    wavelength_tol_um: float = Query(
        change_scores.DEFAULT_WAVELENGTH_TOL_UM,
        gt=0.0,
        le=1.0,
        description=(
            "Max |Δλ| (µm) to treat frames as wavelength-matched. "
            "Default ≈ one D1 resolution element (~0.03 µm); see docs/SCIENCE_LIMITS.md."
        ),
    ),
    target: Optional[str] = None,
    live: bool = Query(
        False,
        description="If true, attempt IRSA cutouts (slow). Default uses demo float bins / cache only.",
    ),
) -> ChangeScoresResponse | JSONResponse:
    """
    Per-frame change scores at (ra, dec). Candidates only — not discoveries.
    Offline: serves/computes from demo-data float bins; never 500s blank.
    """
    banner: Optional[str] = None
    source = DataSource.live
    frames_in: list[change_scores.FrameInput] = []
    ax = ay = None

    # Prefer computing from demo float bins when a known target is requested
    # (works offline; also used as fallback).
    def _from_demo(tid: str) -> Optional[ChangeScoresResponse]:
        nonlocal banner, source, ax, ay
        demo_dir = DEMO_DATA / tid
        cache_path = demo_dir / "change_scores.json"
        man = _demo_manifest(tid)
        if not man:
            return None
        target_ra = float(man.get("ra", ra))
        target_dec = float(man.get("dec", dec))
        # Cache hit when request matches cutout CRVAL *or* catalog epoch (high-PM packs).
        from .sky_match import manifest_center_match

        at_target = manifest_center_match(ra, dec, man)
        if (
            cache_path.exists()
            and at_target
            and abs(radius - 1.5) < 1e-6
        ):
            cached = read_json(cache_path)
            # Prefer matching metric/reference slice if present
            slices = cached.get("by_key") or {}
            key = f"{metric}|{reference}|{radius}"
            payload = slices.get(key) or cached.get("default")
            if payload and payload.get("frames"):
                source = DataSource.cached_demo
                banner = "using cached demo data"
                motion = payload.get("motion")
                if not motion:
                    score_objs = [
                        change_scores.FrameChangeScore(**{**f, "notes": list(f.get("notes") or [])})
                        for f in payload["frames"]
                    ]
                    motion = change_scores.net_motion(score_objs)
                resp = ChangeScoresResponse(
                    ra=ra,
                    dec=dec,
                    radius_pix=radius,
                    metric=metric,
                    reference=reference,
                    frames=[ChangeScoreFrame(**f) for f in payload["frames"]],
                    motion=motion,
                    source=source,
                    pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
                    aperture_x_pix=payload.get("aperture_x_pix"),
                    aperture_y_pix=payload.get("aperture_y_pix"),
                    is_synthetic=bool(payload.get("is_synthetic", False)),
                    banner=banner,
                    wavelength_tol_um=payload.get("wavelength_tol_um", wavelength_tol_um),
                    n_wavelength_excluded=int(payload.get("n_wavelength_excluded") or 0),
                    wavelength_status=payload.get("wavelength_status"),
                    wavelength_message=payload.get("wavelength_message"),
                )
                return _with_wavelength_meta(resp, wavelength_tol_um=wavelength_tol_um)
        try:
            fin, ax, ay = change_scores.load_demo_frame_inputs(
                demo_dir,
                ra=ra,
                dec=dec,
                target_ra=target_ra,
                target_dec=target_dec,
                pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
            )
        except FileNotFoundError:
            return None
        scores = change_scores.score_frames(
            fin,
            metric=metric,  # type: ignore[arg-type]
            reference=reference,  # type: ignore[arg-type]
            aperture_pix=radius,
            wavelength_tol_um=wavelength_tol_um,
            use_motion_window=True,
        )
        motion = change_scores.net_motion(scores)
        source = DataSource.cached_demo
        banner = "using cached demo data"
        resp = ChangeScoresResponse(
            ra=ra,
            dec=dec,
            radius_pix=radius,
            metric=metric,
            reference=reference,
            frames=[ChangeScoreFrame(**s.to_dict()) for s in scores],
            motion=motion,
            source=source,
            pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
            aperture_x_pix=ax,
            aperture_y_pix=ay,
            is_synthetic=False,
            banner=banner,
        )
        return _with_wavelength_meta(resp, wavelength_tol_um=wavelength_tol_um, scores=scores)

    try:
        if target and target in TEST_TARGETS:
            resp = _from_demo(target)
            if resp is not None:
                return resp
        # Try nearest demo target by catalog RA/Dec
        for tid, meta in TEST_TARGETS.items():
            man = _demo_manifest(tid)
            if not man:
                continue
            if abs(float(man["ra"]) - ra) < 0.05 and abs(float(man["dec"]) - dec) < 0.05:
                resp = _from_demo(tid)
                if resp is not None:
                    return resp
    except Exception as exc:
        logger.warning("change-scores demo path failed: %s", exc)

    # Opt-in live IRSA path (slow; default stays offline-safe)
    if live:
        try:
            bandpass = "SPHEREx-D1"
            if target and target in DEFAULT_DETECTOR_BY_TARGET:
                bandpass = DEFAULT_DETECTOR_BY_TARGET[target]
            obs = adapter.find_observations(
                ra, dec, fov_deg=0.15, bandpasses=(bandpass,), prefer="sia"
            )
            chosen = _select_blink_epochs(obs, max_frames=8)
            cut_objs = []
            for o in chosen:
                cut = adapter.fetch_cutout(
                    o, subtract_zodi=True, center_ra=ra, center_dec=dec, size_deg=0.05
                )
                cut = adapter.parse_cutout_fits(
                    cut.fits_path, o, subtract_zodi=True, target_ra=ra, target_dec=dec
                )
                cut_objs.append(cut)
            if len(cut_objs) < 2:
                raise RuntimeError("fewer than 2 live cutouts for change scores")
            ref = Frame(cut_objs[0].image, cut_objs[0].wcs)
            aligned_imgs = align_frames(
                [
                    Frame(c.image, c.wcs, c.variance, c.flags, c.observation.mjd)
                    for c in cut_objs
                ],
                ref,
            )
            try:
                x0, y0 = cut_objs[0].wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
                ax, ay = float(x0), float(y0)
            except Exception:
                ay, ax = (np.array(aligned_imgs[0].shape) - 1) / 2.0
            for c, img in zip(cut_objs, aligned_imgs):
                frames_in.append(
                    change_scores.FrameInput(
                        epoch_id=f"{c.observation.obs_id}|{c.observation.bandpass}|{c.observation.mjd}",
                        mjd=c.observation.mjd,
                        image=np.asarray(img, dtype=float),
                        variance=c.variance,
                        flags=c.flags,
                        wavelength_um=c.central_wavelength_um,
                        detector=c.observation.detector,
                        x_pix=float(ax),
                        y_pix=float(ay),
                    )
                )
            scores = change_scores.score_frames(
                frames_in,
                metric=metric,  # type: ignore[arg-type]
                reference=reference,  # type: ignore[arg-type]
                aperture_pix=radius,
                wavelength_tol_um=wavelength_tol_um,
                use_motion_window=True,
            )
            resp = ChangeScoresResponse(
                ra=ra,
                dec=dec,
                radius_pix=radius,
                metric=metric,
                reference=reference,
                frames=[ChangeScoreFrame(**s.to_dict()) for s in scores],
                motion=change_scores.net_motion(scores),
                source=DataSource.live,
                pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
                aperture_x_pix=float(ax) if ax is not None else None,
                aperture_y_pix=float(ay) if ay is not None else None,
                is_synthetic=False,
                banner=None,
            )
            return _with_wavelength_meta(
                resp, wavelength_tol_um=wavelength_tol_um, scores=scores
            )
        except Exception as exc:
            logger.warning("live change-scores failed: %s", exc)
            return _service_unavailable(
                "/api/change-scores",
                f"live change scores failed: {exc}",
                source="error",
            )

    return _service_unavailable(
        "/api/change-scores",
        "No cached change scores for this position. Pass target=<demo id> "
        "or live=1 when IRSA is reachable.",
        source="cached-demo",
    )


@app.get("/api/pixel", response_model=PixelInspectorResponse)
def pixel_inspector(
    target: str = Query(..., description="Demo target id"),
    epoch_id: str = Query(..., description="Frame epoch_id from manifest"),
    x: float = Query(..., description="Pixel x (0-based)"),
    y: float = Query(..., description="Pixel y (0-based)"),
) -> PixelInspectorResponse:
    """Scientific pixel values from demo float IMAGE (+ FLAGS when packed).

    VARIANCE/ZODI are not in the offline pack — reported as not computed.
    Wavelength is the frame central λ (WCS-WAVE at target), not full LVF at cursor.
    """
    from .adapters.spherex import FLAG_BITS

    demo_dir = DEMO_DATA / target
    man_path = demo_dir / "manifest.json"
    if not man_path.exists():
        raise HTTPException(404, f"demo target not found: {target}")
    man = json.loads(man_path.read_text(encoding="utf-8"))
    frames = man.get("frames") or []
    fr = next((f for f in frames if str(f.get("epoch_id")) == str(epoch_id)), None)
    if fr is None:
        # Allow substring match (obs_id|band|mjd fragments)
        fr = next((f for f in frames if epoch_id in str(f.get("epoch_id"))), None)
    if fr is None:
        raise HTTPException(404, f"epoch_id not found: {epoch_id}")

    shape = tuple(fr.get("float_shape") or fr.get("image_shape") or [0, 0])
    h, w = int(shape[0]), int(shape[1])
    if h < 1 or w < 1:
        raise HTTPException(422, "frame has no float_shape / image_shape")

    ix = int(round(float(x)))
    iy = int(round(float(y)))
    if ix < 0 or iy < 0 or ix >= w or iy >= h:
        raise HTTPException(
            422,
            f"pixel ({ix},{iy}) out of bounds for shape ({h},{w})",
        )

    image_val = None
    bin_name = fr.get("float_bin")
    if bin_name:
        bp = demo_dir / bin_name
        if bp.exists():
            img = np.fromfile(bp, dtype=np.float32).reshape(h, w)
            image_val = float(img[iy, ix])

    flags_raw = None
    flags_set: list[str] = []
    flags_name = fr.get("flags_bin")
    if flags_name:
        fp = demo_dir / flags_name
        if fp.exists():
            raw = fp.read_bytes()
            n = h * w
            if len(raw) == n * 2:
                fl = np.frombuffer(raw, dtype=np.int16).reshape(h, w)
            elif len(raw) == n * 4:
                fl = np.frombuffer(raw, dtype=np.int32).reshape(h, w)
            elif len(raw) == n:
                fl = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
            else:
                fl = None
            if fl is not None:
                flags_raw = int(fl[iy, ix])
                for name, bit in FLAG_BITS.items():
                    if flags_raw & (1 << bit):
                        flags_set.append(name)

    return PixelInspectorResponse(
        target_id=target,
        epoch_id=str(fr.get("epoch_id")),
        x_pix=float(ix),
        y_pix=float(iy),
        image_mjy_sr=image_val,
        bunit=str(fr.get("bunit") or man.get("bunit") or "MJy/sr"),
        flags_raw=flags_raw,
        flags_set=flags_set,
        variance=None,
        zodi_mjy_sr=None,
        central_wavelength_um=(
            float(fr["central_wavelength_um"])
            if fr.get("central_wavelength_um") is not None
            else None
        ),
        source=DataSource.cached_demo,
        is_synthetic=False,
        note=(
            "IMAGE from float .bin; FLAGS decoded via Explanatory Supplement Table 16. "
            "No discovery claim."
        ),
    )


@app.get("/api/scoreboard", response_model=ScoreboardResponse)
def scoreboard() -> ScoreboardResponse:
    self_test = validate.fit_motion_self_test()
    payload: dict[str, Any] = {
        "motion_fit_self_test": self_test,
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
    }
    source = DataSource.live
    if SCOREBOARD_PATH.exists():
        file_data = read_json(SCOREBOARD_PATH)
        payload.update(file_data)
        source = DataSource(file_data.get("source", "cached-demo"))
    return ScoreboardResponse(
        source=source,
        results=payload,
        is_synthetic_injected=bool(payload.get("synthetic", {}).get("is_synthetic")),
        explanation=(
            "Recovery counts compare detections to known movers within 2 SPHEREx pixels. "
            "Misses are shown deliberately. Synthetic injections are labeled is_synthetic. "
            "This does not claim discovery of Planet X."
        ),
    )


# --- Discovery Mode votes (SQLite optional) ---
def _votes_conn():
    VOTES_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(VOTES_DB)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS votes (
        candidate_id TEXT, vote TEXT, ts REAL
        )"""
    )
    conn.commit()
    return conn


@app.post("/api/votes")
def post_vote(candidate_id: str, vote: Literal["moved", "didnt", "unsure"]):
    conn = _votes_conn()
    import time

    conn.execute(
        "INSERT INTO votes(candidate_id, vote, ts) VALUES (?,?,?)",
        (candidate_id, vote, time.time()),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "source": "live"}


@app.get("/api/votes/{candidate_id}")
def get_votes(candidate_id: str):
    conn = _votes_conn()
    rows = conn.execute(
        "SELECT vote, COUNT(*) FROM votes WHERE candidate_id=? GROUP BY vote",
        (candidate_id,),
    ).fetchall()
    conn.close()
    counts = {k: v for k, v in rows}
    total = sum(counts.values())
    moved = counts.get("moved", 0)
    return {
        "candidate_id": candidate_id,
        "counts": counts,
        "n_votes": total,
        "agreement_pct_moved": (100.0 * moved / total) if total else None,
        "note": "Agreement percentage among volunteers — not a discovery claim.",
        "source": "live",
    }


# --- Community observations (unverified) ---
from .observations.schema import ObservationCreate  # noqa: E402
from .observations import service as obs_service  # noqa: E402
from .observations.db import connect as obs_connect, delete_submission as obs_delete  # noqa: E402


@app.post("/api/observations")
async def post_observation(
    request: Request,
    payload: ObservationCreate,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    if idempotency_key and not payload.idempotency_key:
        payload.idempotency_key = idempotency_key
    elif idempotency_key:
        payload.idempotency_key = idempotency_key
    # Coarse client key: no plain IP stored on the report
    fwd = request.headers.get("x-forwarded-for", "")
    peer = request.client.host if request.client else "unknown"
    raw = (fwd.split(",")[0].strip() or peer)[:64]
    known = set(payload.allowed_epoch_ids) if payload.allowed_epoch_ids else None
    result = obs_service.submit_observation(
        payload,
        client_raw_key=raw,
        known_epoch_ids=known,
        git_commit=os.environ.get("SKYFLIP_GIT_COMMIT", ""),
    )
    if not result.get("ok"):
        return JSONResponse(
            status_code=int(result.get("status_code", 400)),
            content={
                "ok": False,
                "errors": result.get("errors", []),
                "detail": "validation failed",
            },
        )
    return JSONResponse(status_code=int(result.get("status_code", 201)), content=result)


@app.delete("/api/observations/{submission_id}")
def delete_observation(submission_id: str, delete_token: str = Query(...)):
    conn = obs_connect()
    ok = obs_delete(conn, submission_id, delete_token)
    conn.close()
    if not ok:
        raise HTTPException(404, "Not found or bad delete token")
    return {"ok": True, "deleted": submission_id}


@app.get("/api/observations")
def list_observations(
    admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
    status: Optional[str] = None,
    target: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    if not obs_service.require_admin(admin_token):
        raise HTTPException(401, "Admin token required")
    rows = obs_service.list_submissions(
        status=status, target_id=target, limit=limit, offset=offset
    )
    return {"ok": True, "results": rows, "note": "Community observations, unverified."}


@app.get("/api/observations/aggregate")
def observations_aggregate(
    admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
    cone_arcsec: float = Query(12.3, gt=0),
):
    if not obs_service.require_admin(admin_token):
        raise HTTPException(401, "Admin token required")
    groups = obs_service.aggregate_by_sky(cone_arcsec=cone_arcsec)
    return {
        "ok": True,
        "groups": groups,
        "label": "agreement among community reports, not a detection",
    }


@app.get("/api/observations/{submission_id}")
def get_observation_admin(
    submission_id: str,
    admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
):
    if not obs_service.require_admin(admin_token):
        raise HTTPException(401, "Admin token required")
    from .observations.db import get_submission

    conn = obs_connect()
    row = get_submission(conn, submission_id)
    conn.close()
    if not row:
        raise HTTPException(404, "Not found")
    # Strip delete_token from admin list? Keep for ops; never expose contact here without join
    return {"ok": True, "submission": dict(row)}


from .batches import router as batch_router, recover_interrupted
from .archive.routes import app as archive_router
app.include_router(batch_router)
app.include_router(archive_router)

@app.on_event("startup")
def initialize_storage():
    recover_interrupted()

@app.exception_handler(sqlite3.Error)
async def database_error(request: Request, exc: sqlite3.Error):
    logger.exception("Database operation failed", exc_info=exc)
    return JSONResponse(status_code=503, content={"detail": {"kind": "database", "message": "Database unavailable. Check storage path, write permissions and disk space."}})

@app.get("/api/status")
def system_status():
    try:
        from .batches import initialize
        initialize()
        return {"status": "ok", "backend": "ok", "database": "ok", "archive": "not_checked", "version": "merged-1.0"}
    except (sqlite3.Error, OSError):
        return JSONResponse(status_code=503, content={"status":"degraded", "backend":"ok", "database":"unavailable", "archive":"not_checked"})


@app.middleware("http")
async def validate_query_coordinates(request: Request, call_next):
    import math
    if request.url.path.startswith('/api/'):
        for key, lo, hi in [('ra',0,360),('dec',-90,90)]:
            if key in request.query_params:
                try:
                    value = float(request.query_params[key])
                    if not math.isfinite(value) or not lo <= value <= hi or (key == 'ra' and value == 360):
                        raise ValueError()
                except ValueError:
                    return JSONResponse(status_code=422, content={'detail': {'kind':'invalid_input', 'message':f'{key} must be finite and between {lo} and {hi} degrees (RA < 360).'}})
    return await call_next(request)
