"""API tests for POST /api/observations."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

# Isolate DB before importing app
@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SKYFLIP_OBSERVATIONS_DB", str(tmp_path / "obs.sqlite3"))
    monkeypatch.setenv("SKYFLIP_ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("SKYFLIP_OBS_RATE_LIMIT", "50")
    from importlib import reload
    import app.observations.db as dbmod
    import app.main as mainmod

    reload(dbmod)
    reload(mainmod)
    return TestClient(mainmod.app)


def _body(**kw):
    base = {
        "schema_version": 1,
        "idempotency_key": "api-test-key-001",
        "description": "Faint point hopped between two frames near the center.",
        "context": {
            "ra": 133.795,
            "dec": -7.245,
            "target_id": "wise0855",
            "ra_dec_source": "target_button",
            "data_source": "cached-demo",
        },
        "frames": [
            {
                "epoch_id": "e0",
                "obs_id": "o0",
                "mjd": 1.0,
                "image_shape": [29, 29],
            },
            {
                "epoch_id": "e1",
                "obs_id": "o1",
                "mjd": 2.0,
                "image_shape": [29, 29],
            },
        ],
        "highlights": [
            {
                "epoch_id": "e0",
                "mode": "default",
                "pixel": {"x0": 5, "y0": 5, "x1": 10, "y1": 10},
                "sky_corners": [],
            },
            {
                "epoch_id": "e1",
                "mode": "custom",
                "pixel": {"x0": 6, "y0": 6, "x1": 11, "y1": 11},
                "sky_corners": [],
            },
        ],
        "answers": {"direction": "not_sure", "confidence": 3},
        "form_ms": 5000,
        "honeypot": "",
        "allowed_epoch_ids": ["e0", "e1"],
    }
    base.update(kw)
    return base


def test_post_observation_ok(client):
    r = client.post("/api/observations", json=_body())
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["ok"] is True
    assert "submission_id" in body
    assert "delete_token" in body
    assert "unverified" in body["disclaimer"].lower()


def test_idempotency(client):
    b = _body(idempotency_key="api-test-key-dup")
    r1 = client.post("/api/observations", json=b)
    r2 = client.post("/api/observations", json=b)
    assert r1.json()["submission_id"] == r2.json()["submission_id"]
    assert r2.json().get("reused") is True


def test_admin_requires_token(client):
    r = client.get("/api/observations")
    assert r.status_code == 401
    r2 = client.get("/api/observations", headers={"X-Admin-Token": "wrong"})
    assert r2.status_code == 401
    r3 = client.get("/api/observations", headers={"X-Admin-Token": "test-admin-token"})
    assert r3.status_code == 200


def test_bad_words_400(client):
    words = " ".join(f"w{i}" for i in range(301))
    r = client.post("/api/observations", json=_body(description=words, idempotency_key="long-desc-001"))
    assert r.status_code == 400
    assert r.json()["ok"] is False
