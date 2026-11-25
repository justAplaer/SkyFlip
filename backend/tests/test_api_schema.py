"""API schema smoke tests (TestClient, mocked IRSA where needed)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_schema():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert "status" in body
    assert "services" in body
    assert "demo_cache_available" in body
    assert body["pixel_scale_arcsec"] == 6.15
    assert body["source"] in ("live", "cached-demo")


def test_change_scores_cached_demo():
    # Catalog epoch OR cutout CRVAL must hit cache (high-PM packs differ).
    r = client.get(
        "/api/change-scores",
        params={
            "ra": 133.79512917,  # catalog epoch
            "dec": -7.24514722,
            "radius": 1.5,
            "metric": "brightness_snr",
            "reference": "median_others",
            "target": "wise0855",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "cached-demo"
    assert body["banner"] and "cached" in body["banner"].lower()
    assert body["metric"] == "brightness_snr"
    assert len(body["frames"]) >= 2
    for fr in body["frames"]:
        assert fr["status"] in ("ok", "not_computed")
        if fr["status"] == "not_computed":
            assert fr["score"] is None
        else:
            assert fr["score"] is not None
            assert fr["score_err"] is not None or "no uncertainty" in (
                fr.get("status_reason") or ""
            )
        assert "epoch_id" in fr
        assert "mjd" in fr


def test_change_scores_no_500_without_target():
    # Unknown field with no demo nearby — expect 200 from nearest demo or 503 JSON
    r = client.get(
        "/api/change-scores",
        params={"ra": 0.0, "dec": 0.0, "radius": 1.5},
    )
    assert r.status_code in (200, 503)
    body = r.json()
    assert "detail" in body or "frames" in body
    if r.status_code == 503:
        assert body.get("ok") is False
        assert body.get("endpoint") == "/api/change-scores"


def test_pixel_inspector_demo_wise0855():
    # Use first frame from WISE 0855 manifest
    import json
    from pathlib import Path

    man = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "frontend"
            / "public"
            / "demo-data"
            / "wise0855"
            / "manifest.json"
        ).read_text()
    )
    fr = man["frames"][0]
    shape = fr.get("float_shape") or fr.get("image_shape")
    cx = (shape[1] - 1) / 2.0
    cy = (shape[0] - 1) / 2.0
    r = client.get(
        "/api/pixel",
        params={
            "target": "wise0855",
            "epoch_id": fr["epoch_id"],
            "x": cx,
            "y": cy,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_id"] == "wise0855"
    assert body["image_mjy_sr"] is not None
    assert body["bunit"] == "MJy/sr"
    assert body["variance"] is None  # not packed
    assert "not computed" in body["variance_note"].lower()
    assert isinstance(body["flags_set"], list)
