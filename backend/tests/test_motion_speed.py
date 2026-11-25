"""Speed / distance conversions from cited pm_table parallax (no inventions)."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.motion_speed import (
    KM_S_PER_ARCSEC_YR_PC,
    MOON_WIDTH_ARCSEC,
    distance_from_parallax_mas,
    moon_widths_for_mu,
    motion_speed_for_target,
    tangential_velocity_kms,
    total_pm_arcsec_yr,
)
from app.pm_table import clear_pm_table_cache


@pytest.fixture(autouse=True)
def _clear_pm():
    clear_pm_table_cache()
    yield
    clear_pm_table_cache()


client = TestClient(app)


def test_kms_formula_hand_calculation():
    # μ = 10″/yr, d = 2 pc → v = 4.74047 * 10 * 2 = 94.8094 km/s
    v = tangential_velocity_kms(10.0, 2.0)
    assert math.isclose(v, KM_S_PER_ARCSEC_YR_PC * 10.0 * 2.0, rel_tol=1e-12)
    assert math.isclose(v, 94.8094, rel_tol=1e-6)


def test_unit_conversions_moon_and_decade():
    mu = 9.0
    fam = moon_widths_for_mu(mu)
    assert fam["arcsec_per_year"] == 9.0
    assert fam["arcsec_per_decade"] == 90.0
    assert math.isclose(fam["moon_widths_per_year"], 9.0 / MOON_WIDTH_ARCSEC)
    assert math.isclose(fam["years_per_moon_width"], MOON_WIDTH_ARCSEC / 9.0)


def test_null_parallax_handling():
    pc, ly, note = distance_from_parallax_mas(None)
    assert pc is None and ly is None
    assert "not cached" in note.lower() or "parallax" in note.lower()


def test_barnard_has_cited_parallax_and_kms():
    data = motion_speed_for_target("barnards_star")
    assert data["is_mover"] is True
    assert data["parallax_mas"] == pytest.approx(546.9759, rel=1e-6)
    assert data["distance_pc"] == pytest.approx(1000.0 / 546.9759, rel=1e-6)
    mu = total_pm_arcsec_yr(-0.801551, 10.362394)
    assert data["pm_total_arcsec_yr"] == pytest.approx(mu, rel=1e-6)
    expect_v = KM_S_PER_ARCSEC_YR_PC * mu * data["distance_pc"]
    assert data["tangential_velocity_kms"] == pytest.approx(expect_v, rel=1e-6)
    assert "Gaia DR3" in (data["parallax_citation"] or "")


def test_wise0855_has_cited_parallax_and_kms():
    data = motion_speed_for_target("wise0855")
    assert data["is_mover"] is True
    assert data["parallax_mas"] == pytest.approx(449.0, rel=1e-9)
    assert data["distance_pc"] == pytest.approx(1000.0 / 449.0, rel=1e-6)
    mu = total_pm_arcsec_yr(-8.06, 0.7)
    expect_v = KM_S_PER_ARCSEC_YR_PC * mu * data["distance_pc"]
    assert data["tangential_velocity_kms"] == pytest.approx(expect_v, rel=1e-6)
    assert "Luhman" in (data["parallax_citation"] or "")


def test_epsilon_indi_b_has_cited_parallax_and_kms():
    data = motion_speed_for_target("epsilon_indi_b")
    assert data["is_mover"] is True
    assert data["parallax_mas"] == pytest.approx(274.99, rel=1e-6)
    mu = total_pm_arcsec_yr(3.96141, -2.53608)
    expect_v = KM_S_PER_ARCSEC_YR_PC * mu * data["distance_pc"]
    assert data["tangential_velocity_kms"] == pytest.approx(expect_v, rel=1e-6)
    assert "Chen" in (data["parallax_citation"] or "")


def test_variable_controls_have_cited_speed_not_high_pm():
    """RW Aur / R Dra stay non-movers for tracks but still fill How fast is it?."""
    data = motion_speed_for_target("r_draconis")
    assert data["is_mover"] is False
    assert data["is_variable_control"] is True
    assert data["pm_total_arcsec_yr"] > 0
    assert data["parallax_mas"] == pytest.approx(1.2509, rel=1e-6)
    assert data["tangential_velocity_kms"] is not None
    assert data["tangential_velocity_kms"] > 0
    assert "Gaia DR3" in (data["pm_citation"] or "")

    rw = motion_speed_for_target("rw_aurigae")
    assert rw["is_mover"] is False
    assert rw["is_variable_control"] is True
    assert rw["pm_total_arcsec_yr"] > 0
    assert rw["parallax_mas"] == pytest.approx(6.4062, rel=1e-6)
    assert rw["tangential_velocity_kms"] is not None
    assert rw["tangential_velocity_kms"] > 0
    # Distinct speeds across the five demo targets
    barn = motion_speed_for_target("barnards_star")
    wise = motion_speed_for_target("wise0855")
    indi = motion_speed_for_target("epsilon_indi_b")
    speeds = {
        round(barn["tangential_velocity_kms"]),
        round(wise["tangential_velocity_kms"]),
        round(indi["tangential_velocity_kms"]),
        round(rw["tangential_velocity_kms"]),
        round(data["tangential_velocity_kms"]),
    }
    assert len(speeds) == 5


def test_api_motion_speed():
    r = client.get("/api/motion-speed", params={"target": "barnards_star"})
    assert r.status_code == 200
    body = r.json()
    assert body["tangential_velocity_kms"] is not None
    assert body["familiar"]["years_per_moon_width"] is not None

    r404 = client.get("/api/motion-speed", params={"target": "nope"})
    assert r404.status_code == 404
