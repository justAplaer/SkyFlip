"""Submit / list / export / aggregate observation reports."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from typing import Any, Optional

from .auth import check_admin_token
from .db import (
    check_rate_limit,
    connect,
    delete_submission,
    get_submission,
    insert_submission,
    migrate,
    observations_db_path,
)
from .schema import ObservationCreate, SubmissionStatus
from .validate_report import validate_observation

try:
    import app as _app_pkg  # noqa: F401

    GIT_COMMIT = os.environ.get("SKYFLIP_GIT_COMMIT", "")
except Exception:
    GIT_COMMIT = ""


def client_key_hash(raw: str, salt: Optional[str] = None) -> str:
    s = salt or os.environ.get("SKYFLIP_RATE_SALT", "skyflip-dev-salt")
    return hashlib.sha256(f"{s}:{raw}".encode()).hexdigest()


def submit_observation(
    payload: ObservationCreate,
    *,
    client_raw_key: str = "anon",
    known_epoch_ids: Optional[set[str]] = None,
    app_version: str = "0.2.0",
    git_commit: str = "",
) -> dict[str, Any]:
    if payload.context.batch_id:
        from ..batches import get_batch
        from fastapi import HTTPException
        try:
            batch = get_batch(payload.context.batch_id)
        except HTTPException:
            return {"ok": False, "status_code": 400, "errors": [{"field": "context.batch_id", "message": "Batch does not exist."}]}
        known_epoch_ids = {f['epoch_id'] for f in batch['data']['frames']}
        req = batch['request']
        if (abs(payload.context.ra-req['ra']) > 1e-8 or abs(payload.context.dec-req['dec']) > 1e-8 or payload.context.image_mode != req['view_mode']):
            return {"ok": False, "status_code": 400, "errors": [{"field": "context", "message": "Report coordinates and image mode must match the saved batch."}]}
        # Freeze authoritative image metadata instead of trusting client-supplied URLs.
        from .schema import FrameRef
        authoritative = {f['epoch_id']: f for f in batch['data']['frames']}
        for i, frame in enumerate(payload.frames):
            if frame.epoch_id not in authoritative:
                return {"ok": False, "status_code": 400, "errors": [{"field": "frames", "message": "Image is not in the selected batch."}]}
            f = authoritative[frame.epoch_id]
            payload.frames[i] = FrameRef(**{k:v for k,v in f.items() if k in FrameRef.model_fields}, image_shape=f.get('array_shape') or [], cutout_url=f.get('source_url'))
    result = validate_observation(payload, known_epoch_ids=known_epoch_ids)
    if not result.ok:
        return {
            "ok": False,
            "status_code": 400,
            "errors": [e.model_dump() for e in result.errors],
            "word_count": result.word_count,
        }

    conn = connect()
    migrate(conn)
    limit = int(os.environ.get("SKYFLIP_OBS_RATE_LIMIT", "5"))
    ck = client_key_hash(client_raw_key)
    # Idempotent replay bypasses rate limit increment if already stored
    existing = conn.execute(
        "SELECT submission_id FROM observation_submissions WHERE idempotency_key=?",
        (payload.idempotency_key,),
    ).fetchone()
    if not existing:
        if not check_rate_limit(conn, ck, limit=limit):
            conn.close()
            return {
                "ok": False,
                "status_code": 429,
                "errors": [{"field": "rate", "message": "Rate limit exceeded (try later)."}],
            }

    status = (
        SubmissionStatus.needs_review if result.needs_review else SubmissionStatus.new
    )
    row = insert_submission(
        conn,
        payload,
        app_version=app_version,
        git_commit=git_commit or GIT_COMMIT,
        client_key_hash=ck,
        needs_review=result.needs_review,
        status=status,
    )
    # Optional email — never fail submit
    try:
        _maybe_alert(row["submission_id"])
    except Exception:
        pass
    conn.close()
    return {
        "ok": True,
        "status_code": 200 if row.get("reused") else 201,
        "submission_id": row["submission_id"],
        "delete_token": row["delete_token"],
        "created_at": row["created_at"],
        "reused": row.get("reused", False),
        "status": row.get("status", "new"),
        "disclaimer": "Community observation, unverified — not a discovery.",
    }


def _maybe_alert(submission_id: str) -> None:
    to = os.environ.get("SKYFLIP_ALERT_TO")
    if not to:
        return
    # Stub: log only unless SMTP configured later
    import logging

    logging.getLogger("skyflip.observations").info(
        "New observation %s (alert to %s skipped if no SMTP)", submission_id, to
    )


def require_admin(token: Optional[str]) -> bool:
    return check_admin_token(token)


def list_submissions(
    *,
    status: Optional[str] = None,
    target_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    conn = connect()
    migrate(conn)
    q = (
        "SELECT submission_id, created_at, status, target_id, target_name, ra, dec, "
        "word_count, is_synthetic, needs_review, answers_json FROM observation_submissions WHERE 1=1"
    )
    args: list[Any] = []
    if status:
        q += " AND status=?"
        args.append(status)
    if target_id:
        q += " AND target_id=?"
        args.append(target_id)
    q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    args.extend([limit, offset])
    rows = conn.execute(q, args).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            ans = json.loads(d.pop("answers_json") or "{}")
            d["confidence"] = ans.get("confidence")
            d["direction"] = ans.get("direction")
        except Exception:
            d["confidence"] = None
        out.append(d)
    return out


def aggregate_by_sky(
    *,
    cone_arcsec: float = 12.3,  # ~2 SPHEREx pixels
    min_reports: int = 2,
) -> list[dict[str, Any]]:
    """Group nearby reports; rank by count × mean confidence. Not a detection."""
    conn = connect()
    migrate(conn)
    rows = conn.execute(
        "SELECT submission_id, ra, dec, answers_json, is_synthetic FROM observation_submissions "
        "WHERE status NOT IN ('rejected')"
    ).fetchall()
    conn.close()
    items = []
    for r in rows:
        ans = json.loads(r["answers_json"] or "{}")
        items.append(
            {
                "submission_id": r["submission_id"],
                "ra": r["ra"],
                "dec": r["dec"],
                "confidence": float(ans.get("confidence") or 3),
                "direction": ans.get("direction"),
                "is_synthetic": bool(r["is_synthetic"]),
            }
        )
    # Greedy clustering
    used = set()
    groups = []
    cone_deg = cone_arcsec / 3600.0
    for i, a in enumerate(items):
        if i in used:
            continue
        members = [a]
        used.add(i)
        for j, b in enumerate(items):
            if j in used:
                continue
            if _sep_deg(a["ra"], a["dec"], b["ra"], b["dec"]) <= cone_deg:
                members.append(b)
                used.add(j)
        if len(members) < min_reports:
            continue
        mean_c = sum(m["confidence"] for m in members) / len(members)
        dirs = [m["direction"] for m in members if m.get("direction")]
        agree = max((dirs.count(d) for d in set(dirs)), default=0) if dirs else 0
        groups.append(
            {
                "n_reports": len(members),
                "mean_confidence": mean_c,
                "direction_agreement": agree,
                "ra": sum(m["ra"] for m in members) / len(members),
                "dec": sum(m["dec"] for m in members) / len(members),
                "submission_ids": [m["submission_id"] for m in members],
                "has_synthetic": any(m["is_synthetic"] for m in members),
                "label": "agreement among community reports, not a detection",
                "score": len(members) * mean_c + agree,
            }
        )
    groups.sort(key=lambda g: g["score"], reverse=True)
    return groups


def _sep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    import math

    c1 = math.cos(math.radians(dec1))
    dra = (ra1 - ra2) * c1
    ddec = dec1 - dec2
    return math.hypot(dra, ddec)
