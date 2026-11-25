"""Validation scoreboard computation."""

from __future__ import annotations

from typing import Any

import numpy as np

from .detect import Track, fit_linear_motion, Detection


def recovery_stats(
    known_tracks: list[dict[str, Any]],
    found: list[Track],
    *,
    match_arcsec: float = 12.0,
) -> dict[str, Any]:
    """
    Compare detected tracks to known movers.
    known_tracks items: {id, ra, dec, pm_ra, pm_dec} at a reference epoch.
    """
    matched = []
    missed = []
    for k in known_tracks:
        hit = None
        for tr in found:
            if not tr.detections:
                continue
            # compare mean position
            ra = np.mean([d.ra for d in tr.detections])
            dec = np.mean([d.dec for d in tr.detections])
            dra = (ra - k["ra"]) * np.cos(np.deg2rad(k["dec"])) * 3600
            ddec = (dec - k["dec"]) * 3600
            if np.hypot(dra, ddec) < match_arcsec:
                hit = tr.id
                break
        if hit:
            matched.append({"known_id": k["id"], "track_id": hit})
        else:
            missed.append(k["id"])

    false_candidates = [
        tr.id
        for tr in found
        if tr.id not in {m["track_id"] for m in matched} and not tr.is_synthetic
    ]
    return {
        "n_known": len(known_tracks),
        "n_recovered": len(matched),
        "n_missed": len(missed),
        "recovery_rate": (len(matched) / len(known_tracks)) if known_tracks else None,
        "matched": matched,
        "missed": missed,
        "false_candidate_ids": false_candidates,
        "n_false_candidates": len(false_candidates),
        "match_radius_arcsec": match_arcsec,
        "uncertainty_note": "Match radius is 2 native SPHEREx pixels (2×6.15\").",
    }


def synthetic_recovery_curve(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate injected-mover recovery vs brightness/speed bins. All synthetic."""
    return {
        "is_synthetic": True,
        "bins": results,
        "note": "Injected movers at real SPHEREx epochs; labeled is_synthetic.",
    }


def fit_motion_self_test() -> dict[str, Any]:
    """Unit-style self check: synthetic linear track recovers known PM."""
    truth_pm_ra = 800.0  # arcsec/yr
    truth_pm_dec = -400.0
    ra0, dec0 = 100.0, -10.0
    dets = []
    for i, mjd in enumerate([60000.0, 60180.0, 60360.0]):
        dt = (mjd - 60000.0) / 365.25
        ra = ra0 + (truth_pm_ra / 3600.0) * dt / np.cos(np.deg2rad(dec0))
        dec = dec0 + (truth_pm_dec / 3600.0) * dt
        dets.append(
            Detection(
                epoch_id=f"e{i}",
                mjd=mjd,
                x=10 + i,
                y=10 + i,
                ra=ra,
                dec=dec,
                flux=10.0,
                x_err=0.2,
                y_err=0.2,
            )
        )
    tr = Track(id="synth", detections=dets, is_synthetic=True)
    fit_linear_motion(tr)
    return {
        "is_synthetic": True,
        "truth_pm_ra": truth_pm_ra,
        "truth_pm_dec": truth_pm_dec,
        "fit_pm_ra": tr.pm_ra_arcsec_yr,
        "fit_pm_dec": tr.pm_dec_arcsec_yr,
        "fit_pm_ra_err": tr.pm_ra_err,
        "fit_pm_dec_err": tr.pm_dec_err,
        "ok": abs((tr.pm_ra_arcsec_yr or 0) - truth_pm_ra) < 5
        and abs((tr.pm_dec_arcsec_yr or 0) - truth_pm_dec) < 5,
    }
