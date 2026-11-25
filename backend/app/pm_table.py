"""Single source of truth for demo-target proper motions and historical markers.

Machine-readable table: frontend/public/demo-data/pm_table.json
(also used offline by the UI). Do not invent PM values — cite or mark unavailable.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from astropy.time import Time

# backend/app/pm_table.py → repo root
_REPO = Path(__file__).resolve().parents[2]
PM_TABLE_PATH = _REPO / "frontend" / "public" / "demo-data" / "pm_table.json"


@lru_cache(maxsize=1)
def load_pm_table() -> dict[str, Any]:
    if not PM_TABLE_PATH.exists():
        return {"targets": [], "notes": []}
    return json.loads(PM_TABLE_PATH.read_text(encoding="utf-8"))


def clear_pm_table_cache() -> None:
    load_pm_table.cache_clear()


def find_target_row(name_or_id: str) -> Optional[dict[str, Any]]:
    needle = (name_or_id or "").strip().lower()
    if not needle:
        return None
    for row in load_pm_table().get("targets", []):
        tid = str(row.get("target_id", "")).lower()
        name = str(row.get("name", "")).lower()
        if needle == tid or needle == name or needle in name or tid in needle.replace(" ", "_"):
            return row
        # WISE 0855 aliases
        if tid == "wise0855" and ("0855" in needle or "wise" in needle):
            return row
        if tid == "barnards_star" and "barnard" in needle:
            return row
        if tid == "epsilon_indi_b" and ("indi" in needle or "ε indi" in needle):
            return row
    return None


def is_variable_control(row: dict[str, Any], *, floor_arcsec_yr: float = 0.05) -> bool:
    """True for variable / non-mover controls (RW Aur, R Dra) — not high-PM recovery targets."""
    note = str(row.get("classification_note") or "").lower()
    if "variable" in note or "not a high-pm" in note:
        return True
    mu = (
        float(row.get("pm_ra_cosdec_arcsec_yr") or 0.0) ** 2
        + float(row.get("pm_dec_arcsec_yr") or 0.0) ** 2
    ) ** 0.5
    cite = str(row.get("citation") or "").lower()
    return mu < floor_arcsec_yr and "no proper motion" in cite


def row_to_pm_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Shape expected by catalogs.propagate_position."""
    epoch = row.get("ref_epoch")
    if isinstance(epoch, (int, float)):
        ref = Time(float(epoch), format="decimalyear")
    elif isinstance(epoch, str) and epoch:
        try:
            ref = Time(float(epoch), format="decimalyear")
        except Exception:
            ref = Time(2016.0, format="decimalyear")
    else:
        ref = Time(2016.0, format="decimalyear")

    pm_ra_err = row.get("pm_ra_err")
    pm_dec_err = row.get("pm_dec_err")
    classification_note = row.get("classification_note")
    return {
        "ra": float(row["ra"]),
        "dec": float(row["dec"]),
        "pm_ra_cosdec_arcsec_yr": float(row.get("pm_ra_cosdec_arcsec_yr") or 0.0),
        "pm_dec_arcsec_yr": float(row.get("pm_dec_arcsec_yr") or 0.0),
        "pm_ra_err": float(pm_ra_err) if pm_ra_err is not None else None,
        "pm_dec_err": float(pm_dec_err) if pm_dec_err is not None else None,
        "ref_epoch": ref,
        "citation": row.get("citation") or "pm_table.json",
        "uncertainty_note": row.get("uncertainty_note") or "no uncertainty available",
        "target_id": row.get("target_id"),
        "name": row.get("name"),
        "source": "pm_table",
        "classification_note": classification_note,
        "is_variable_control": is_variable_control(row),
        "is_high_pm_mover": not is_variable_control(row)
        and (
            float(row.get("pm_ra_cosdec_arcsec_yr") or 0.0) ** 2
            + float(row.get("pm_dec_arcsec_yr") or 0.0) ** 2
        )
        ** 0.5
        >= 0.05,
    }


def pm_for_name(name_or_id: str) -> Optional[dict[str, Any]]:
    row = find_target_row(name_or_id)
    if not row:
        return None
    return row_to_pm_dict(row)


def historical_markers_for_row(row: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    markers = list(row.get("historical_markers") or [])
    missing = list(row.get("missing_markers") or [])
    return markers, missing
