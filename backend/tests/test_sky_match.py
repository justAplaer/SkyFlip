"""Unit tests for cache position-match guard (Bug 1)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.sky_match import (
    CACHE_POSITION_TOL_DEG,
    manifest_center_match,
    positions_match,
)

client = TestClient(app)


def test_positions_match_same_point():
    assert positions_match(269.45, 4.69, 269.45, 4.69) is True


def test_positions_match_within_tolerance():
    # 0.01° ≈ 36″ < default 0.02°
    assert positions_match(133.795, -7.245, 133.805, -7.245) is True


def test_positions_match_rejects_far_field():
    # Barnard's ≈ (269.45, 4.69) vs WISE 0855 ≈ (133.8, -7.25)
    assert positions_match(269.45, 4.69, 133.795, -7.245) is False


def test_positions_match_respects_tol():
    assert positions_match(0.0, 0.0, 0.05, 0.0, tol_deg=0.02) is False
    assert positions_match(0.0, 0.0, 0.01, 0.0, tol_deg=CACHE_POSITION_TOL_DEG) is True


def test_manifest_center_match_accepts_catalog_or_cutout():
    man = {
        "ra": 269.4498,
        "dec": 4.7226,
        "catalog_ra": 269.4521,
        "catalog_dec": 4.6934,
    }
    assert manifest_center_match(269.4521, 4.6934, man) is True
    assert manifest_center_match(269.4498, 4.7226, man) is True
    assert manifest_center_match(133.795, -7.245, man) is False


def test_cutouts_refuse_mismatched_demo_target(monkeypatch):
    """If live fails and target=barnards_star but RA/Dec are elsewhere → 503, no frames."""

    def boom(*_a, **_k):
        raise RuntimeError("forced IRSA failure for test")

    monkeypatch.setattr(
        "app.main.adapter.find_observations",
        boom,
    )

    # Request WISE 0855 coordinates but ask for Barnard's cache — must NOT serve Barnard's pixels
    r = client.get(
        "/api/cutouts",
        params={
            "ra": 133.79512917,
            "dec": -7.24514722,
            "fov": 0.2,
            "target": "barnards_star",
            "detector": 1,
        },
    )
    assert r.status_code == 503, r.text
    body = r.json()
    # FastAPI may wrap detail as string or object depending on raise style
    detail = body.get("detail", body)
    text = detail if isinstance(detail, str) else str(detail)
    msg = (
        detail.get("message", "")
        if isinstance(detail, dict)
        else text
    )
    assert any(
        s in str(msg).lower()
        for s in (
            "no cached data for this position",
            "archive returned no observation covering this position",
            "network or archive unreachable",
            "position outside coverage",
        )
    ), msg
    assert "frames" not in body or not body.get("frames")


def test_cutouts_allow_matching_demo_target(monkeypatch):
    """Live fail + matching RA/Dec for barnards_star → cached-demo OK."""

    def boom(*_a, **_k):
        raise RuntimeError("forced IRSA failure for test")

    monkeypatch.setattr("app.main.adapter.find_observations", boom)

    r = client.get(
        "/api/cutouts",
        params={
            "ra": 269.4520769586187,
            "dec": 4.69336496657667,
            "fov": 0.2,
            "target": "barnards_star",
            "detector": 1,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "cached-demo"
    assert len(body["frames"]) >= 2
