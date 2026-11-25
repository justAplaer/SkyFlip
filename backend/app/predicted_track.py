"""Build historical-position overlays + PM-propagated ghost tracks.

Uses pm_table.json (SSOT) + astropy SkyCoord.apply_space_motion.
"""

from __future__ import annotations

from typing import Any, Optional

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time
from astropy.wcs import WCS

from .adapters import catalogs
from .models import (
    DataSource,
    HistoricalMarker,
    MissingMarker,
    PredictedTrackPoint,
    PredictedTrackResponse,
    ProperMotionInfo,
)
from .pm_table import find_target_row, historical_markers_for_row

PIXEL_SCALE_ARCSEC = 6.15


def _ref_epoch_year(pm: dict[str, Any]) -> float:
    ref = pm.get("ref_epoch")
    if isinstance(ref, Time):
        return float(ref.decimalyear)
    try:
        return float(ref)
    except Exception:
        return 2016.0


def _offset_uncertainty_arcsec(pm: dict[str, Any], dt_yr: float) -> tuple[Optional[float], str]:
    era = pm.get("pm_ra_err")
    ede = pm.get("pm_dec_err")
    if era is None or ede is None:
        return None, pm.get("uncertainty_note") or "no uncertainty available"
    # σ_offset ≈ |dt| * hypot(σ_pmra, σ_pmdec); ignores position error at catalog epoch
    sig = abs(dt_yr) * float(np.hypot(era, ede))
    return float(sig), f"|Δt|×hypot(σ_μα,σ_μδ) = {sig:.3f}\" (PM errors only)"


def _world_to_pix(wcs: WCS, ra: float, dec: float) -> tuple[Optional[float], Optional[float]]:
    try:
        x, y = wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
        return float(x), float(y)
    except Exception:
        return None, None


def _separation_arcsec(ra0: float, dec0: float, ra1: float, dec1: float) -> float:
    a = SkyCoord(ra0 * u.deg, dec0 * u.deg)
    b = SkyCoord(ra1 * u.deg, dec1 * u.deg)
    return float(a.separation(b).arcsec)


def build_predicted_track(
    *,
    name: str,
    cutout_ra: float,
    cutout_dec: float,
    frames: list[dict[str, Any]],
    wcs: WCS,
    pixel_scale_arcsec: float = PIXEL_SCALE_ARCSEC,
    source: DataSource = DataSource.cached_demo,
) -> PredictedTrackResponse:
    """
    frames: list of {epoch_id, mjd, ...}
    cutout_ra/dec: TAN WCS CRVAL (fixed-sky cutout center).
    Catalog position comes from pm_table / get_proper_motion (epoch of PM).
    """
    pm = catalogs.get_proper_motion(name, cutout_ra, cutout_dec)
    catalog_ra = float(pm.get("ra", cutout_ra))
    catalog_dec = float(pm.get("dec", cutout_dec))
    ref_year = _ref_epoch_year(pm)

    row = find_target_row(name)
    raw_markers, raw_missing = historical_markers_for_row(row) if row else ([], [])
    if not raw_markers and (
        abs(pm.get("pm_ra_cosdec_arcsec_yr") or 0) > 0 or abs(pm.get("pm_dec_arcsec_yr") or 0) > 0
    ):
        raw_markers = [
            {
                "id": "catalog_epoch",
                "label": f"Catalog @ {ref_year:.1f}",
                "ra": catalog_ra,
                "dec": catalog_dec,
                "epoch": ref_year,
                "epoch_note": f"PM reference epoch {ref_year}",
                "citation": pm.get("citation") or "",
                "position_uncertainty_arcsec": None,
                "uncertainty_note": pm.get("uncertainty_note") or "no uncertainty available",
            }
        ]

    markers: list[HistoricalMarker] = []
    for m in raw_markers:
        x, y = _world_to_pix(wcs, float(m["ra"]), float(m["dec"]))
        markers.append(
            HistoricalMarker(
                id=str(m["id"]),
                label=str(m["label"]),
                ra=float(m["ra"]),
                dec=float(m["dec"]),
                epoch=float(m["epoch"]),
                epoch_note=str(m.get("epoch_note") or ""),
                citation=str(m.get("citation") or ""),
                x_pix=x,
                y_pix=y,
                position_uncertainty_arcsec=m.get("position_uncertainty_arcsec"),
                uncertainty_note=str(m.get("uncertainty_note") or "no uncertainty available"),
            )
        )

    missing = [
        MissingMarker(id=str(m["id"]), label=str(m["label"]), reason=str(m["reason"]))
        for m in raw_missing
    ]

    points: list[PredictedTrackPoint] = []
    for fr in frames:
        mjd = float(fr["mjd"])
        obstime = Time(mjd, format="mjd")
        pra, pdec = catalogs.propagate_position(catalog_ra, catalog_dec, pm, obstime)
        x_pix, y_pix = _world_to_pix(wcs, pra, pdec)
        dt_yr = float(obstime.decimalyear) - ref_year
        offset = _separation_arcsec(catalog_ra, catalog_dec, pra, pdec)
        off_unc, off_note = _offset_uncertainty_arcsec(pm, dt_yr)
        points.append(
            PredictedTrackPoint(
                epoch_id=str(fr["epoch_id"]),
                mjd=mjd,
                ra=float(pra),
                dec=float(pdec),
                x_pix=x_pix,
                y_pix=y_pix,
                offset_from_catalog_arcsec=float(offset),
                offset_from_catalog_pix=float(offset / pixel_scale_arcsec),
                offset_uncertainty_arcsec=off_unc,
                offset_uncertainty_note=off_note,
                note=(
                    f"apply_space_motion from epoch {ref_year:.4f} → MJD {mjd:.5f}; "
                    f"offset {offset:.2f}\" ≈ {offset / pixel_scale_arcsec:.2f} pix; "
                    f"{pm.get('citation')}; {off_note}"
                ),
            )
        )

    pm_info = ProperMotionInfo(
        pm_ra_cosdec_arcsec_yr=float(pm.get("pm_ra_cosdec_arcsec_yr") or 0.0),
        pm_dec_arcsec_yr=float(pm.get("pm_dec_arcsec_yr") or 0.0),
        pm_ra_err=pm.get("pm_ra_err"),
        pm_dec_err=pm.get("pm_dec_err"),
        ref_epoch=ref_year,
        citation=str(pm.get("citation") or ""),
        uncertainty_note=str(pm.get("uncertainty_note") or "no uncertainty available"),
        source=str(pm.get("source") or "unknown"),
    )

    method = (
        f"SkyCoord.apply_space_motion from catalog epoch {ref_year:.4f}; "
        f"PM: {pm.get('citation')}; {pm.get('uncertainty_note')}"
    )

    return PredictedTrackResponse(
        name=name,
        ra=cutout_ra,
        dec=cutout_dec,
        points=points,
        source=source,
        method=method,
        pixel_scale_arcsec=pixel_scale_arcsec,
        historical_markers=markers,
        missing_markers=missing,
        proper_motion=pm_info,
    )


def response_from_cached_json(cached: dict[str, Any], name: str, ra: float, dec: float) -> PredictedTrackResponse:
    """Hydrate API model from demo predicted_track.json (may be older schema)."""
    points = [PredictedTrackPoint(**p) for p in cached.get("points", [])]
    markers = [HistoricalMarker(**m) for m in cached.get("historical_markers", [])]
    missing = [MissingMarker(**m) for m in cached.get("missing_markers", [])]
    pm_raw = cached.get("proper_motion")
    pm_info = ProperMotionInfo(**pm_raw) if isinstance(pm_raw, dict) else None
    return PredictedTrackResponse(
        name=cached.get("name") or name,
        ra=float(cached.get("ra", ra)),
        dec=float(cached.get("dec", dec)),
        points=points,
        source=DataSource.cached_demo,
        method=cached.get("method", "cached demo predicted track"),
        pixel_scale_arcsec=float(cached.get("pixel_scale_arcsec", PIXEL_SCALE_ARCSEC)),
        historical_markers=markers,
        missing_markers=missing,
        proper_motion=pm_info,
    )
