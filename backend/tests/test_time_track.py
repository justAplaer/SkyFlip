"""Time-machine track: Barnard's ~113″ in ~11 yr, monotonic, cos(dec), 404."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.pm_table import clear_pm_table_cache
from app.time_track import build_time_track, math_cos_dec_factor


@pytest.fixture(autouse=True)
def _clear_pm():
    clear_pm_table_cache()
    yield
    clear_pm_table_cache()


client = TestClient(app)


def test_barnard_2016_to_2026_9_about_113_arcsec():
    data = build_time_track(
        target="barnards_star",
        start_year=2016.0,
        end_year=2026.9,
        n=50,
    )
    assert data["is_mover"] is True
    last = data["points"][-1]
    # μ ≈ 10.393″/yr × 10.9 yr ≈ 113.3″
    assert 108.0 <= last["offset_from_catalog_arcsec"] <= 118.0


def test_track_monotonic_in_time_and_offset():
    data = build_time_track(
        target="barnards_star",
        start_year=2010.0,
        end_year=2035.0,
        n=26,
    )
    years = [p["decimal_year"] for p in data["points"]]
    assert years == sorted(years)
    offsets = [p["offset_from_catalog_arcsec"] for p in data["points"]]
    # Offsets from catalog epoch grow as we leave 2016 in either direction;
    # step sizes between consecutive samples should be non-negative.
    steps = [p["step_arcsec"] for p in data["points"]]
    assert all(s >= -1e-6 for s in steps)
    assert offsets[-1] > offsets[len(offsets) // 2] or offsets[0] > 0


def test_missing_target_returns_404():
    r = client.get("/api/track", params={"target": "not_a_real_target_xyz"})
    assert r.status_code == 404
    assert "pm_table" in r.json()["detail"].lower() or "unknown" in r.json()["detail"].lower()


def test_cos_dec_factor_in_ra_offset():
    # At dec=60°, ΔRA=1° on-sky is 0.5°; factor = cos(60)=0.5
    assert math.isclose(math_cos_dec_factor(60.0), 0.5, rel_tol=1e-6)
    data = build_time_track(
        target="barnards_star",
        start_year=2016.0,
        end_year=2017.0,
        n=2,
    )
    p0, p1 = data["points"][0], data["points"][1]
    # Hand check: μ_α* = -0.801551″/yr, μ_δ = 10.362394″/yr → Δ ≈ hypot
    expected = math.hypot(0.801551, 10.362394)
    assert math.isclose(p1["offset_from_catalog_arcsec"], expected, rel_tol=0.02)


def test_variable_star_flat_track():
    data = build_time_track(
        target="r_draconis",
        start_year=2010.0,
        end_year=2035.0,
        n=11,
    )
    assert data["is_mover"] is False
    assert data["non_mover_message"]
    ras = {round(p["ra"], 8) for p in data["points"]}
    decs = {round(p["dec"], 8) for p in data["points"]}
    assert len(ras) == 1 and len(decs) == 1


def test_api_track_barnard_ok():
    r = client.get(
        "/api/track",
        params={"target": "barnards_star", "start": "2016.0", "end": "2026.9", "n": 40},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_mover"] is True
    assert len(body["points"]) == 40
    assert any(k["kind"] == "gaia" for k in body["key_dates"])
    assert any(k["kind"] == "spherex" for k in body["key_dates"])
