"""Tangential speed and distance from pm_table.json (never invent parallax)."""

from __future__ import annotations

import math
from typing import Any, Optional

from .pm_table import find_target_row, is_variable_control

# Astronomical convention: v_t [km/s] = 4.74047 * μ["/yr] * d[pc]
KM_S_PER_ARCSEC_YR_PC = 4.74047
# Rough full-Moon angular diameter used only for a familiar comparison.
MOON_WIDTH_ARCSEC = 1800.0
PC_TO_LY = 3.261563777


def total_pm_arcsec_yr(pm_ra_cosdec: float, pm_dec: float) -> float:
    """Total proper motion; pm_ra already includes cos(dec)."""
    return float(math.hypot(pm_ra_cosdec, pm_dec))


def position_angle_deg(pm_ra_cosdec: float, pm_dec: float) -> Optional[float]:
    """Position angle of motion on the sky, degrees from North toward East."""
    if pm_ra_cosdec == 0.0 and pm_dec == 0.0:
        return None
    ang = math.degrees(math.atan2(pm_ra_cosdec, pm_dec)) % 360.0
    return float(ang)


def distance_from_parallax_mas(
    parallax_mas: Optional[float],
) -> tuple[Optional[float], Optional[float], str]:
    """Return (distance_pc, distance_ly, note). Null when parallax missing/invalid."""
    if parallax_mas is None:
        return None, None, "parallax not cached in pm_table.json"
    try:
        plx = float(parallax_mas)
    except (TypeError, ValueError):
        return None, None, "parallax not cached in pm_table.json"
    if not math.isfinite(plx) or plx <= 0.0:
        return None, None, "parallax not positive — distance undefined"
    pc = 1000.0 / plx
    ly = pc * PC_TO_LY
    return float(pc), float(ly), f"distance = 1000 / parallax_mas ({plx} mas)"


def tangential_velocity_kms(mu_arcsec_yr: float, distance_pc: float) -> float:
    return float(KM_S_PER_ARCSEC_YR_PC * mu_arcsec_yr * distance_pc)


def moon_widths_for_mu(mu_arcsec_yr: float) -> dict[str, Optional[float]]:
    """Familiar-unit comparisons from μ; never hardcode a per-target Moon figure."""
    if mu_arcsec_yr <= 0:
        return {
            "arcsec_per_year": 0.0,
            "arcsec_per_decade": 0.0,
            "moon_widths_per_year": 0.0,
            "years_per_moon_width": None,
        }
    per_yr = mu_arcsec_yr / MOON_WIDTH_ARCSEC
    return {
        "arcsec_per_year": float(mu_arcsec_yr),
        "arcsec_per_decade": float(mu_arcsec_yr * 10.0),
        "moon_widths_per_year": float(per_yr),
        "years_per_moon_width": float(MOON_WIDTH_ARCSEC / mu_arcsec_yr),
    }


def motion_speed_for_target(target_id_or_name: str) -> dict[str, Any]:
    """Build the motion/speed payload for one curated target (or raise KeyError)."""
    row = find_target_row(target_id_or_name)
    if not row:
        raise KeyError(f"Unknown target {target_id_or_name!r} — not in pm_table.json")

    pm_ra = float(row.get("pm_ra_cosdec_arcsec_yr") or 0.0)
    pm_dec = float(row.get("pm_dec_arcsec_yr") or 0.0)
    mu = total_pm_arcsec_yr(pm_ra, pm_dec)
    variable = is_variable_control(row)
    # High-PM movers (≥0.05″/yr) drive blink tracks; variables may still have
    # small cited Gaia PM shown on the Speed card.
    is_mover = (not variable) and mu >= 0.05
    has_speed = mu > 0.0

    plx = row.get("parallax_mas")
    plx_err = row.get("parallax_err_mas")
    plx_cite = row.get("parallax_citation")
    dist_pc, dist_ly, dist_note = distance_from_parallax_mas(
        float(plx) if plx is not None else None
    )

    v_tan: Optional[float] = None
    v_note = "tangential velocity needs both proper motion and a cited parallax"
    if has_speed and dist_pc is not None:
        v_tan = tangential_velocity_kms(mu, dist_pc)
        v_note = (
            f"v = {KM_S_PER_ARCSEC_YR_PC} × μ(\"/yr) × d(pc) "
            f"= {KM_S_PER_ARCSEC_YR_PC} × {mu:.4f} × {dist_pc:.4f}"
        )
    elif not has_speed:
        v_note = "no measurable proper motion — tangential velocity not applicable"
    elif dist_pc is None:
        v_note = dist_note

    radial_value = row.get("radial_velocity_kms")
    radial = float(radial_value) if radial_value is not None else None
    if radial is not None and (not math.isfinite(radial) or not row.get("radial_velocity_citation")):
        radial = None
    # Proper motion/parallax are barycentric catalog quantities; the supplied
    # line-of-sight velocity is heliocentric or barycentric, an approximation
    # to a Sun-relative speed. The two components are orthogonal.
    total = math.hypot(v_tan, radial) if v_tan is not None and radial is not None else None
    moon = moon_widths_for_mu(mu if has_speed else 0.0)

    return {
        "target_id": row.get("target_id"),
        "name": row.get("name"),
        "is_mover": is_mover,
        "is_variable_control": variable,
        "pm_ra_cosdec_arcsec_yr": pm_ra,
        "pm_dec_arcsec_yr": pm_dec,
        "pm_total_arcsec_yr": mu if has_speed else 0.0,
        "position_angle_deg": position_angle_deg(pm_ra, pm_dec) if has_speed else None,
        "pm_citation": row.get("citation") or "pm_table.json",
        "pm_uncertainty_note": row.get("uncertainty_note") or "no uncertainty available",
        "parallax_mas": float(plx) if plx is not None else None,
        "parallax_err_mas": float(plx_err) if plx_err is not None else None,
        "parallax_citation": plx_cite,
        "parallax_missing_reason": None
        if plx is not None
        else (
            "parallax not cached in pm_table.json"
            if has_speed
            else "not applicable (no measurable proper motion)"
        ),
        "distance_pc": dist_pc,
        "distance_ly": dist_ly,
        "distance_note": dist_note if dist_pc is not None else dist_note,
        "tangential_velocity_kms": v_tan,
        "radial_velocity_kms": radial,
        "radial_velocity_citation": row.get("radial_velocity_citation"),
        "radial_velocity_url": row.get("radial_velocity_url"),
        "radial_velocity_note": row.get("radial_velocity_note"),
        "solar_speed_kms": total,
        "tangential_velocity_note": v_note,
        "familiar": moon,
        "formula_note": (
            "Tangential velocity uses only the sky-plane motion: "
            f"v[km/s] = {KM_S_PER_ARCSEC_YR_PC} × μ[arcsec/yr] × d[pc]. "
            "Distance is 1000/parallax_mas when a cited parallax exists. "
            "Never invents parallax or distance."
        ),
    }
