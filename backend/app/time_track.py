"""Dense proper-motion track for the Time machine slider (2010–2035)."""

from __future__ import annotations

from typing import Any, Optional

import numpy as np
from astropy.time import Time

from .adapters import catalogs
from .motion_speed import motion_speed_for_target, total_pm_arcsec_yr
from .pm_table import find_target_row, is_variable_control, load_pm_table


def _decimal_year_to_time(year: float) -> Time:
    return Time(float(year), format="decimalyear")


def _iso_from_decimal_year(year: float) -> str:
    t = _decimal_year_to_time(year)
    # Prefer calendar date YYYY-MM-DD for share URLs / UI
    return t.strftime("%Y-%m-%d")


def _mjd_from_decimal_year(year: float) -> float:
    return float(_decimal_year_to_time(year).mjd)


def build_time_track(
    *,
    target: str,
    start_year: float = 2010.0,
    end_year: float = 2035.0,
    n: int = 101,
    spherex_frames: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """
    Propagate catalog PM from start→end.

    Unknown target → KeyError.
    Zero-PM / variable controls → flat track with is_mover=False (not an error).
    """
    row = find_target_row(target)
    if not row:
        raise KeyError(
            f"Unknown target {target!r}: not in pm_table.json. "
            "Time machine requires a curated target with catalog PM."
        )

    if end_year <= start_year:
        raise ValueError("end must be after start")
    n = int(max(2, min(n, 501)))

    pm = catalogs.get_proper_motion(
        str(row.get("name") or target),
        float(row["ra"]),
        float(row["dec"]),
    )
    catalog_ra = float(pm.get("ra", row["ra"]))
    catalog_dec = float(pm.get("dec", row["dec"]))
    ref = pm.get("ref_epoch")
    if isinstance(ref, Time):
        ref_year = float(ref.decimalyear)
    else:
        try:
            ref_year = float(ref)
        except Exception:
            ref_year = float(row.get("ref_epoch") or 2016.0)

    pm_ra = float(pm.get("pm_ra_cosdec_arcsec_yr") or 0.0)
    pm_dec = float(pm.get("pm_dec_arcsec_yr") or 0.0)
    mu = total_pm_arcsec_yr(pm_ra, pm_dec)
    variable = is_variable_control(row)
    is_mover = (not variable) and mu >= 0.05

    years = np.linspace(start_year, end_year, n)
    points: list[dict[str, Any]] = []
    prev_ra = catalog_ra
    prev_dec = catalog_dec
    for y in years:
        obstime = _decimal_year_to_time(float(y))
        if is_mover:
            pra, pdec = catalogs.propagate_position(
                catalog_ra, catalog_dec, pm, obstime
            )
        else:
            pra, pdec = catalog_ra, catalog_dec
        # Arc length from catalog epoch (great-circle approx via small-angle with cos dec)
        dra = (pra - catalog_ra) * math_cos_dec_factor(catalog_dec) * 3600.0
        ddec = (pdec - catalog_dec) * 3600.0
        offset = float(np.hypot(dra, ddec))
        # Monotonic step from previous sample
        step = float(
            np.hypot(
                (pra - prev_ra) * math_cos_dec_factor(catalog_dec) * 3600.0,
                (pdec - prev_dec) * 3600.0,
            )
        )
        points.append(
            {
                "date_iso": _iso_from_decimal_year(float(y)),
                "decimal_year": float(y),
                "mjd": _mjd_from_decimal_year(float(y)),
                "ra": float(pra),
                "dec": float(pdec),
                "offset_from_catalog_arcsec": offset,
                "step_arcsec": step,
            }
        )
        prev_ra, prev_dec = pra, pdec

    key_dates = _key_dates(row, ref_year, spherex_frames or [])

    speed = motion_speed_for_target(str(row.get("target_id") or target))

    era = pm.get("pm_ra_err")
    ede = pm.get("pm_dec_err")
    # Uncertainty grows roughly |Δt| × hypot(σμ)
    unc_rate = None
    if era is not None and ede is not None:
        unc_rate = float(np.hypot(float(era), float(ede)))

    return {
        "target_id": row.get("target_id"),
        "name": row.get("name"),
        "is_mover": is_mover,
        "start_year": float(start_year),
        "end_year": float(end_year),
        "n": n,
        "catalog_ra": catalog_ra,
        "catalog_dec": catalog_dec,
        "ref_epoch": ref_year,
        "proper_motion": {
            "pm_ra_cosdec_arcsec_yr": pm_ra,
            "pm_dec_arcsec_yr": pm_dec,
            "pm_total_arcsec_yr": mu,
            "pm_ra_err": era,
            "pm_dec_err": ede,
            "ref_epoch": ref_year,
            "citation": pm.get("citation") or row.get("citation"),
            "uncertainty_note": pm.get("uncertainty_note")
            or row.get("uncertainty_note")
            or "no uncertainty available",
            "offset_uncertainty_rate_arcsec_yr": unc_rate,
        },
        "points": points,
        "key_dates": key_dates,
        "motion_speed": speed,
        "honesty": (
            "Predicted from catalog proper motion (source and uncertainty), "
            "not a detection. Positions use SkyCoord.apply_space_motion."
        ),
        "non_mover_message": (
            None
            if is_mover
            else (
                "This is a variable-star control — proper motion is too small to "
                "show as a high-PM track, so it stays put on the sky. Watch for "
                "brightness changes instead."
            )
        ),
        "method": (
            f"SkyCoord.apply_space_motion from catalog epoch {ref_year:.4f}; "
            f"PM: {pm.get('citation')}"
        ),
        "source": "pm_table",
    }


def math_cos_dec_factor(dec_deg: float) -> float:
    """cos(dec) factor for converting ΔRA(deg) to on-sky degrees."""
    return float(max(abs(np.cos(np.deg2rad(dec_deg))), 1e-6))


def _key_dates(
    row: dict[str, Any],
    ref_year: float,
    spherex_frames: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    keys: list[dict[str, Any]] = []
    # WISE-ish epoch from historical markers or WISE designation
    for m in row.get("historical_markers") or []:
        epoch = float(m.get("epoch"))
        mid = str(m.get("id") or "")
        label = str(m.get("label") or mid)
        kind = "catalog"
        if "wise" in mid.lower() or "wise" in label.lower() or abs(epoch - 2010.5) < 0.6:
            kind = "wise"
        elif "gaia" in mid.lower() or "gaia" in label.lower() or abs(epoch - 2016.0) < 0.05:
            kind = "gaia"
        keys.append(
            {
                "id": mid or f"marker_{epoch}",
                "kind": kind,
                "label": label,
                "decimal_year": epoch,
                "date_iso": _iso_from_decimal_year(epoch),
                "epoch_id": None,
            }
        )

    # Always include catalog / Gaia ref epoch if not already present
    if not any(abs(k["decimal_year"] - ref_year) < 0.02 for k in keys):
        kind = "gaia" if abs(ref_year - 2016.0) < 0.05 else "catalog"
        keys.append(
            {
                "id": "ref_epoch",
                "kind": kind,
                "label": f"Catalog epoch {ref_year:.1f}",
                "decimal_year": float(ref_year),
                "date_iso": _iso_from_decimal_year(ref_year),
                "epoch_id": None,
            }
        )

    # WISE epoch tick for packs that only have Gaia markers (still useful on axis)
    if not any(k["kind"] == "wise" for k in keys):
        # Only annotate WISE 2010.5 when the target citation/history mentions WISE
        cite = f"{row.get('citation','')} {row.get('target_id','')}".lower()
        if "wise" in cite or row.get("target_id") == "wise0855":
            keys.append(
                {
                    "id": "wise_epoch",
                    "kind": "wise",
                    "label": "WISE epoch ~2010.5",
                    "decimal_year": 2010.5,
                    "date_iso": "2010-07-02",
                    "epoch_id": None,
                }
            )

    for fr in spherex_frames:
        mjd = fr.get("mjd")
        if mjd is None:
            continue
        t = Time(float(mjd), format="mjd")
        y = float(t.decimalyear)
        keys.append(
            {
                "id": f"spherex_{fr.get('epoch_id', mjd)}",
                "kind": "spherex",
                "label": f"SPHEREx {t.strftime('%Y-%m-%d')}",
                "decimal_year": y,
                "date_iso": t.strftime("%Y-%m-%d"),
                "epoch_id": fr.get("epoch_id"),
                "mjd": float(mjd),
            }
        )

    keys.sort(key=lambda k: k["decimal_year"])
    return keys


def demo_spherex_frames(target_id: str) -> list[dict[str, Any]]:
    """Load SPHEREx frame dates from the offline demo manifest when present."""
    from pathlib import Path
    import json

    root = Path(__file__).resolve().parents[2]
    man = root / "frontend" / "public" / "demo-data" / target_id / "manifest.json"
    if not man.exists():
        return []
    data = json.loads(man.read_text(encoding="utf-8"))
    out = []
    for f in data.get("frames") or []:
        out.append(
            {
                "epoch_id": f.get("epoch_id")
                or f"{f.get('obs_id')}|{f.get('bandpass')}|{f.get('mjd')}",
                "mjd": f.get("mjd"),
                "time_iso": f.get("time_iso"),
            }
        )
    return out
