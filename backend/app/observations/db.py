"""SQLite persistence for observation reports (WAL, parameterized only)."""

from __future__ import annotations

import json
import math
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .sanitize import sanitize_text
from .schema import ObservationCreate, SCHEMA_VERSION, SubmissionStatus
from .wordcount import count_words

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


def observations_db_path() -> Path:
    env = os.environ.get("SKYFLIP_OBSERVATIONS_DB")
    if env:
        return Path(env)
    from ..cache import cache_root

    return cache_root() / "observations.sqlite3"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def healpix_nside32(ra: float, dec: float) -> int:
    """
    Coarse sky cell for grouping (nested HEALPix nside=32).
    Uses a simple equal-area ring approximation if healpy absent.
    """
    try:
        import healpy as hp  # type: ignore

        return int(hp.ang2pix(32, math.radians(90.0 - dec), math.radians(ra), nest=True))
    except Exception:
        # Fallback: 32×64 grid in (ra, dec) — not true HEALPix; TODO(VERIFY) for production
        ix = int((ra % 360.0) / 360.0 * 64) % 64
        iy = int((dec + 90.0) / 180.0 * 32)
        iy = min(max(iy, 0), 31)
        return iy * 64 + ix


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    path = db_path or observations_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
        )"""
    )
    applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
    files = sorted(MIGRATIONS_DIR.glob("*.sql")) if MIGRATIONS_DIR.is_dir() else []
    for f in files:
        # 001_observations.sql → 1
        try:
            ver = int(f.name.split("_", 1)[0])
        except ValueError:
            continue
        if ver in applied:
            continue
        sql = f.read_text(encoding="utf-8")
        conn.executescript(sql)
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?,?)",
            (ver, utc_now_iso()),
        )
        conn.commit()


def insert_submission(
    conn: sqlite3.Connection,
    payload: ObservationCreate,
    *,
    app_version: str = "0.2.0",
    git_commit: str = "",
    client_key_hash: Optional[str] = None,
    needs_review: bool = False,
    status: SubmissionStatus = SubmissionStatus.new,
) -> dict[str, Any]:
    """
    Insert or return existing row for idempotency_key.
    Returns {submission_id, delete_token, created_at, reused: bool}.
    """
    migrate(conn)
    existing = conn.execute(
        "SELECT submission_id, delete_token, created_at FROM observation_submissions WHERE idempotency_key=?",
        (payload.idempotency_key,),
    ).fetchone()
    if existing:
        return {
            "submission_id": existing["submission_id"],
            "delete_token": existing["delete_token"],
            "created_at": existing["created_at"],
            "reused": True,
            "status": "ok",
        }

    sid = str(uuid.uuid4())
    delete_token = secrets.token_urlsafe(24)
    created = utc_now_iso()
    desc = sanitize_text(payload.description)
    wc = count_words(desc)
    is_synth = 1 if (
        payload.is_synthetic_flag or any(f.is_synthetic for f in payload.frames)
    ) else 0
    st = SubmissionStatus.needs_review.value if needs_review else status.value

    conn.execute(
        """INSERT INTO observation_submissions (
          submission_id, idempotency_key, delete_token, created_at, schema_version,
          app_version, git_commit, status, is_synthetic, needs_review,
          target_id, target_name, ra, dec, ra_dec_source, fov_deg, data_source,
          data_release, processing_version, description, word_count,
          answers_json, display_json, frames_json, highlights_json, share_url,
          healpix_nside32, client_key_hash, payload_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid,
            payload.idempotency_key,
            delete_token,
            created,
            SCHEMA_VERSION,
            app_version,
            git_commit,
            st,
            is_synth,
            1 if needs_review else 0,
            payload.context.target_id,
            payload.context.target_name,
            float(payload.context.ra),
            float(payload.context.dec),
            payload.context.ra_dec_source,
            payload.context.fov_deg,
            payload.context.data_source,
            payload.context.data_release,
            payload.context.processing_version,
            desc,
            wc,
            json.dumps(payload.answers.model_dump(mode="json")),
            json.dumps(payload.display.model_dump(mode="json")),
            json.dumps([f.model_dump(mode="json") for f in payload.frames]),
            json.dumps([h.model_dump(mode="json") for h in payload.highlights]),
            payload.display.share_url,
            healpix_nside32(payload.context.ra, payload.context.dec),
            client_key_hash,
            json.dumps(payload.model_dump(mode="json")),
        ),
    )

    if payload.contact_email and payload.contact_consent:
        conn.execute(
            """INSERT INTO observation_contacts(submission_id, email, consent, created_at)
               VALUES (?,?,1,?)""",
            (sid, sanitize_text(payload.contact_email.strip(), max_len=254), created),
        )

    conn.commit()
    return {
        "submission_id": sid,
        "delete_token": delete_token,
        "created_at": created,
        "reused": False,
        "status": st,
    }


def delete_contact(conn: sqlite3.Connection, submission_id: str) -> bool:
    cur = conn.execute(
        "DELETE FROM observation_contacts WHERE submission_id=?",
        (submission_id,),
    )
    conn.commit()
    return cur.rowcount > 0


def delete_submission(
    conn: sqlite3.Connection,
    submission_id: str,
    delete_token: str,
) -> bool:
    row = conn.execute(
        "SELECT delete_token FROM observation_submissions WHERE submission_id=?",
        (submission_id,),
    ).fetchone()
    if not row:
        return False
    if not secrets.compare_digest(row["delete_token"], delete_token):
        return False
    conn.execute("DELETE FROM observation_contacts WHERE submission_id=?", (submission_id,))
    conn.execute("DELETE FROM observation_submissions WHERE submission_id=?", (submission_id,))
    conn.commit()
    return True


def get_submission(conn: sqlite3.Connection, submission_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute(
        "SELECT * FROM observation_submissions WHERE submission_id=?",
        (submission_id,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def check_rate_limit(
    conn: sqlite3.Connection,
    client_key_hash: str,
    *,
    limit: int = 5,
    window_seconds: int = 3600,
) -> bool:
    """Return True if under limit (and increment). False if blocked."""
    migrate(conn)
    now = datetime.now(timezone.utc)
    row = conn.execute(
        "SELECT window_start, count FROM observation_rate_limits WHERE client_key_hash=?",
        (client_key_hash,),
    ).fetchone()
    if row:
        try:
            start = datetime.fromisoformat(row["window_start"].replace("Z", "+00:00"))
        except Exception:
            start = now
        if (now - start).total_seconds() > window_seconds:
            conn.execute(
                "UPDATE observation_rate_limits SET window_start=?, count=1 WHERE client_key_hash=?",
                (utc_now_iso(), client_key_hash),
            )
            conn.commit()
            return True
        if row["count"] >= limit:
            return False
        conn.execute(
            "UPDATE observation_rate_limits SET count=count+1 WHERE client_key_hash=?",
            (client_key_hash,),
        )
        conn.commit()
        return True
    conn.execute(
        "INSERT INTO observation_rate_limits(client_key_hash, window_start, count) VALUES (?,?,1)",
        (client_key_hash, utc_now_iso()),
    )
    conn.commit()
    return True
