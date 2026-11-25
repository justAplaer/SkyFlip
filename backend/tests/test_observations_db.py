"""DB: migrations, idempotency, contact separation, delete, rate limit, auth."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.observations.auth import check_admin_token
from app.observations.db import (
    check_rate_limit,
    connect,
    delete_contact,
    delete_submission,
    get_submission,
    insert_submission,
    migrate,
)
from app.observations.sanitize import escape_for_output
from app.observations.schema import (
    DirectionGuess,
    FrameHighlight,
    FrameRef,
    ObservationAnswers,
    ObservationContext,
    ObservationCreate,
    PixelRect,
)
from app.observations.storage import LocalDiskStorage, StorageError
from app.observations.validate_report import validate_observation


@pytest.fixture()
def db(tmp_path: Path):
    path = tmp_path / "obs.sqlite3"
    conn = connect(path)
    migrate(conn)
    yield conn
    conn.close()


def _payload(key: str = "idem-aaaaaaaa", **kw) -> ObservationCreate:
    base = dict(
        idempotency_key=key,
        description="Faint mover between two epochs near the aperture.",
        context=ObservationContext(ra=10.0, dec=-5.0, target_id="wise0855"),
        frames=[
            FrameRef(epoch_id="a", obs_id="A", mjd=1.0, image_shape=[29, 29]),
            FrameRef(epoch_id="b", obs_id="B", mjd=2.0, image_shape=[29, 29]),
        ],
        highlights=[
            FrameHighlight(epoch_id="a", pixel=PixelRect(x0=1, y0=1, x1=4, y1=4)),
            FrameHighlight(epoch_id="b", pixel=PixelRect(x0=2, y0=2, x1=5, y1=5)),
        ],
        answers=ObservationAnswers(direction=DirectionGuess.up, confidence=4),
        form_ms=4000,
        allowed_epoch_ids=["a", "b"],
    )
    base.update(kw)
    return ObservationCreate(**base)


def test_idempotency_same_key_one_row(db):
    p = _payload()
    assert validate_observation(p).ok
    r1 = insert_submission(db, p, git_commit="deadbeef")
    r2 = insert_submission(db, p, git_commit="deadbeef")
    assert r1["submission_id"] == r2["submission_id"]
    assert r2["reused"] is True
    n = db.execute("SELECT COUNT(*) AS c FROM observation_submissions").fetchone()["c"]
    assert n == 1


def test_contact_separate_and_deletable(db):
    p = _payload(
        key="idem-bbbbbbbb",
        contact_email="volunteer@example.com",
        contact_consent=True,
    )
    r = insert_submission(db, p)
    sid = r["submission_id"]
    row = db.execute(
        "SELECT email FROM observation_contacts WHERE submission_id=?", (sid,)
    ).fetchone()
    assert row["email"] == "volunteer@example.com"
    # Not in main description path as PII dump
    sub = get_submission(db, sid)
    assert "volunteer@example.com" not in sub["description"]
    assert delete_contact(db, sid) is True
    assert (
        db.execute(
            "SELECT COUNT(*) AS c FROM observation_contacts WHERE submission_id=?",
            (sid,),
        ).fetchone()["c"]
        == 0
    )


def test_delete_flow_with_token(db):
    p = _payload(key="idem-cccccccc")
    r = insert_submission(db, p)
    assert delete_submission(db, r["submission_id"], "wrong-token") is False
    assert delete_submission(db, r["submission_id"], r["delete_token"]) is True
    assert get_submission(db, r["submission_id"]) is None


def test_rate_limit(db):
    h = "abc123hash"
    for _ in range(5):
        assert check_rate_limit(db, h, limit=5) is True
    assert check_rate_limit(db, h, limit=5) is False


def test_admin_token_constant_time_env(monkeypatch):
    monkeypatch.delenv("SKYFLIP_ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    assert check_admin_token("anything") is False
    monkeypatch.setenv("SKYFLIP_ADMIN_TOKEN", "secret-token-value")
    assert check_admin_token(None) is False
    assert check_admin_token("wrong") is False
    assert check_admin_token("secret-token-value") is True


def test_sql_html_injection_stored_escaped(db):
    evil = "<script>alert(1)</script>; DROP TABLE observation_submissions;--"
    p = _payload(key="idem-dddddddd", description=f"{evil} faint motion seen.")
    r = insert_submission(db, p)
    sub = get_submission(db, r["submission_id"])
    assert "DROP TABLE" in sub["description"]
    assert "&lt;script&gt;" in escape_for_output(sub["description"])
    # Table still exists
    n = db.execute("SELECT COUNT(*) AS c FROM observation_submissions").fetchone()["c"]
    assert n == 1


def test_local_storage_rejects_path_traversal_and_bad_magic(tmp_path: Path):
    store = LocalDiskStorage(tmp_path / "blob")
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    key = store.put_bytes(png, submission_id="sid1", kind="thumb")
    assert ".." not in key
    with pytest.raises(StorageError):
        store.put_bytes(b"not-a-real-file", submission_id="sid1", kind="x")
    with pytest.raises(StorageError):
        store.get_bytes("../etc/passwd")
