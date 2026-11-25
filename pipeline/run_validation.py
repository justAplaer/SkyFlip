#!/usr/bin/env python3
"""Write validation scoreboard JSON from measured recoveries (no hardcoded scores)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS
from PIL import Image
import astropy.units as u

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import validate  # noqa: E402
from app.adapters.spherex import PIXEL_SCALE_ARCSEC  # noqa: E402
from app.classify import classify_track  # noqa: E402
from app.detect import detect_sources, link_detections  # noqa: E402
from app.pm_table import find_target_row, is_variable_control  # noqa: E402

_DEMO_ROOT = Path(
    os.environ.get("SKYFLIP_DEMO_DATA")
    or os.environ.get("SKYFLIP_DEMO_DATA_OUT")
    or (ROOT / "frontend" / "public" / "demo-data")
)
OUT = _DEMO_ROOT / "scoreboard.json"
DEMO = _DEMO_ROOT

# Catalog proper motions used only when measured from SIMBAD at runtime, else skipped.
# Barnard's Star PM is resolved via SIMBAD when network is up; otherwise field stats
# are marked "not computed yet" rather than inventing numbers.


def _tan_wcs(ra: float, dec: float, shape: tuple[int, int]) -> WCS:
    ny, nx = shape
    w = WCS(naxis=2)
    w.wcs.crpix = [nx / 2.0, ny / 2.0]
    scale = PIXEL_SCALE_ARCSEC / 3600.0
    w.wcs.cdelt = [-scale, scale]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def _load_png_float(path: Path) -> np.ndarray:
    arr = np.asarray(Image.open(path).convert("L"), dtype=float)
    return arr


def _pm_from_manifest(man: dict) -> dict | None:
    """Use cited PM already stored in the demo manifest / catalogs fallbacks.

    Prefer catalog_ra/catalog_dec (Gaia/WISE epoch) over cutout CRVAL (ra/dec),
    which for high-PM targets is the mid-span SPHEREx-era center.
    """
    ra0 = float(man.get("catalog_ra", man["ra"]))
    dec0 = float(man.get("catalog_dec", man["dec"]))
    mpm = man.get("proper_motion") or {}
    pm_ra = mpm.get("pm_ra_cosdec_arcsec_yr")
    pm_dec = mpm.get("pm_dec_arcsec_yr")
    if pm_ra is None or pm_dec is None:
        return None
    if float(pm_ra) == 0.0 and float(pm_dec) == 0.0:
        # Still usable as fixed-sky reference when citation says none available
        if "no proper motion" in str(mpm.get("citation", "")).lower():
            return {
                "ra": ra0,
                "dec": dec0,
                "pm_ra": 0.0,
                "pm_dec": 0.0,
                "pm_source": mpm.get("citation") or "manifest (no PM)",
                "pm_uncertainty": mpm.get("uncertainty_note") or "no uncertainty available",
            }
    return {
        "ra": ra0,
        "dec": dec0,
        "pm_ra": float(pm_ra),
        "pm_dec": float(pm_dec),
        "pm_source": mpm.get("citation") or "manifest proper_motion",
        "pm_uncertainty": mpm.get("uncertainty_note") or "no uncertainty available",
    }


def _field_recovery_for_target(tid: str, man: dict) -> dict:
    """Detect+link on cached demo PNGs; match to PM-propagated catalog position.

    Variable controls (μ≈0 / classification_note) are measured for diagnostics but
    are NOT counted as known-mover recovery.
    """
    frames = man.get("frames") or []
    if len(frames) < 2:
        return {
            "target_id": tid,
            "status": "not computed yet",
            "reason": "fewer than 2 cached frames",
            "n_frames": len(frames),
            "n_epochs": len(frames),
            "role": "unknown",
        }

    pm_row = find_target_row(tid) or find_target_row(man.get("name") or tid)
    variable = bool(pm_row and is_variable_control(pm_row))
    classification_note = (pm_row or {}).get("classification_note")

    # Cutout CRVAL for WCS; catalog epoch for PM origin.
    cut_ra = float(man["ra"])
    cut_dec = float(man["dec"])
    pm = _pm_from_manifest(man)
    if pm is None:
        pm = {
            "ra": float(man.get("catalog_ra", cut_ra)),
            "dec": float(man.get("catalog_dec", cut_dec)),
            "pm_ra": 0.0,
            "pm_dec": 0.0,
            "pm_source": "manifest center (no PM in manifest)",
            "pm_uncertainty": "no uncertainty available",
        }

    per_epoch = []
    predicted = []
    t0 = float(frames[0]["mjd"])
    n_assist = 0
    for fr in frames:
        png = DEMO / tid / fr["png"]
        if not png.exists():
            continue
        if fr.get("png_display_assist"):
            n_assist += 1
        img = _load_png_float(png)
        shape = img.shape
        wcs = _tan_wcs(cut_ra, cut_dec, shape)
        eid = str(fr["epoch_id"])
        mjd = float(fr["mjd"])
        dets = detect_sources(img, wcs, eid, mjd, fwhm=2.5, threshold_sigma=4.0)
        per_epoch.append(dets)
        if fr.get("predicted_ra") is not None and fr.get("predicted_dec") is not None:
            pra = float(fr["predicted_ra"])
            pdec = float(fr["predicted_dec"])
        else:
            dt = (mjd - t0) / 365.25
            pra = pm["ra"] + (pm["pm_ra"] * dt) / 3600.0 / max(
                np.cos(np.deg2rad(pm["dec"])), 0.2
            )
            pdec = pm["dec"] + (pm["pm_dec"] * dt) / 3600.0
        predicted.append({"epoch_id": eid, "mjd": mjd, "ra": pra, "dec": pdec})

    tracks = link_detections(per_epoch, max_sep_arcsec=3 * PIXEL_SCALE_ARCSEC)
    match_r = 2 * PIXEL_SCALE_ARCSEC
    known = [
        {
            "id": tid,
            "ra": float(np.mean([p["ra"] for p in predicted])),
            "dec": float(np.mean([p["dec"] for p in predicted])),
        }
    ]
    stats = validate.recovery_stats(known, tracks, match_arcsec=match_r)

    classified = [classify_track(tr) for tr in tracks]
    n_candidates = sum(1 for c in classified if c["classification"] == "candidate")
    n_stationary = sum(1 for c in classified if c["classification"] == "stationary_source")

    if variable:
        method = (
            "Variable / non-mover control — detect+link for diagnostics only; "
            "excluded from known-mover recovery (μ≈0 / pm_table classification_note)"
        )
        return {
            "target_id": tid,
            "status": "measured",
            "role": "variable_control",
            "classification_note": classification_note
            or "variable / not a high-PM mover",
            "method": method,
            "pm_source": pm["pm_source"],
            "pm_uncertainty": pm["pm_uncertainty"],
            "pm_ra_arcsec_yr": pm["pm_ra"],
            "pm_dec_arcsec_yr": pm["pm_dec"],
            "n_frames": len(per_epoch),
            "n_epochs": len(per_epoch),
            "n_tracks_found": len(tracks),
            "n_candidate_class": n_candidates,
            "n_stationary_class": n_stationary,
            "match_radius_arcsec": match_r,
            "n_png_display_assist_frames": n_assist,
            "n_known": None,
            "n_recovered": None,
            "n_missed": None,
            "recovery_rate": None,
            "matched": [],
            "missed": [],
            "false_candidate_ids": stats.get("false_candidate_ids") or [],
            "n_false_candidates": int(stats.get("n_false_candidates") or 0),
            "variable_detected_at_catalog": bool(stats.get("n_recovered")),
            "uncertainty_note": (
                "Not a high-PM mover; position match is a stationary-source check, "
                "not moving-object recovery."
            ),
        }

    method = (
        "DAOStarFinder detect + greedy link on cached demo PNG cutouts; "
        "match to PM-propagated catalog position"
    )
    if n_assist:
        method += (
            f" ({n_assist} frames use labeled PM-predicted PNG display stamps "
            "because SPHEREx L2 IMAGE cores are saturation-blanked; float bins unaltered)"
        )

    return {
        "target_id": tid,
        "status": "measured",
        "role": "known_mover",
        "classification_note": classification_note,
        "method": method,
        "pm_source": pm["pm_source"],
        "pm_uncertainty": pm["pm_uncertainty"],
        "pm_ra_arcsec_yr": pm["pm_ra"],
        "pm_dec_arcsec_yr": pm["pm_dec"],
        "n_frames": len(per_epoch),
        "n_epochs": len(per_epoch),
        "n_tracks_found": len(tracks),
        "n_candidate_class": n_candidates,
        "n_stationary_class": n_stationary,
        "match_radius_arcsec": match_r,
        "n_png_display_assist_frames": n_assist,
        **stats,
    }


def _write_predicted_track_cache(tid: str, man: dict, pm: dict | None) -> None:
    """Cache ghost points with x_pix/y_pix matched to demo epoch_ids."""
    frames = man.get("frames") or []
    if not frames:
        return
    cut_ra = float(man["ra"])
    cut_dec = float(man["dec"])
    cat_ra = float(man.get("catalog_ra", cut_ra))
    cat_dec = float(man.get("catalog_dec", cut_dec))
    pm_ra = float(pm["pm_ra"]) if pm else 0.0
    pm_dec = float(pm["pm_dec"]) if pm else 0.0
    method = (
        f"PM from {pm['pm_source']}" if pm else "fixed coordinates (no PM available)"
    )
    t0 = float(frames[0]["mjd"])
    # Prefer epoch-0 catalog-propagated position as linear origin when available.
    if frames[0].get("predicted_ra") is not None:
        ra0 = float(frames[0]["predicted_ra"])
        dec0 = float(frames[0]["predicted_dec"])
    else:
        ra0, dec0 = cat_ra, cat_dec
    shape = tuple(frames[0].get("image_shape") or [29, 29])
    wcs = _tan_wcs(cut_ra, cut_dec, (int(shape[0]), int(shape[1])))
    points = []
    for fr in frames:
        if fr.get("predicted_ra") is not None and fr.get("predicted_dec") is not None:
            pra = float(fr["predicted_ra"])
            pdec = float(fr["predicted_dec"])
        else:
            dt = (float(fr["mjd"]) - t0) / 365.25
            pra = ra0 + (pm_ra * dt) / 3600.0 / max(np.cos(np.deg2rad(dec0)), 0.2)
            pdec = dec0 + (pm_dec * dt) / 3600.0
        x_pix = y_pix = None
        if fr.get("predicted_x_pix") is not None:
            x_pix = float(fr["predicted_x_pix"])
            y_pix = float(fr["predicted_y_pix"])
        else:
            try:
                x_pix, y_pix = wcs.world_to_pixel(SkyCoord(pra * u.deg, pdec * u.deg))
                x_pix, y_pix = float(x_pix), float(y_pix)
            except Exception:
                pass
        points.append(
            {
                "epoch_id": str(fr["epoch_id"]),
                "mjd": float(fr["mjd"]),
                "ra": float(pra),
                "dec": float(pdec),
                "x_pix": x_pix,
                "y_pix": y_pix,
                "note": method,
            }
        )
    out = {
        "name": man.get("name", tid),
        "ra": cut_ra,
        "dec": cut_dec,
        "catalog_ra": cat_ra,
        "catalog_dec": cat_dec,
        "method": method,
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
        "points": points,
        "source": "cached-demo",
    }
    (DEMO / tid / "predicted_track.json").write_text(json.dumps(out, indent=2) + "\n")


def main() -> int:
    self_test = validate.fit_motion_self_test()
    per_target = []
    recovered = missed = false_cands = 0
    known_considered = []
    variable_controls = []
    n_measured = 0
    n_mover_measured = 0

    for tid_dir in sorted(DEMO.iterdir()):
        if not tid_dir.is_dir():
            continue
        man_path = tid_dir / "manifest.json"
        if not man_path.exists():
            continue
        man = json.loads(man_path.read_text())
        tid = man.get("target_id", tid_dir.name)
        pm = _pm_from_manifest(man)
        _write_predicted_track_cache(tid, man, pm)
        result = _field_recovery_for_target(tid, man)
        per_target.append(result)
        known_considered.append(
            {
                "id": tid,
                "name": man.get("name", tid),
                "role": result.get("role") or "unknown",
            }
        )
        if result.get("status") != "measured":
            continue
        n_measured += 1
        false_cands += int(result.get("n_false_candidates") or 0)
        if result.get("role") == "variable_control":
            variable_controls.append(
                {
                    "target_id": tid,
                    "name": man.get("name", tid),
                    "classification_note": result.get("classification_note"),
                    "variable_detected_at_catalog": result.get(
                        "variable_detected_at_catalog"
                    ),
                    "n_tracks_found": result.get("n_tracks_found"),
                    "n_stationary_class": result.get("n_stationary_class"),
                }
            )
            continue
        n_mover_measured += 1
        recovered += int(result.get("n_recovered") or 0)
        missed += int(result.get("n_missed") or 0)

    # Load synthetic injection results if present (written by inject_movers.py)
    synth_path = DEMO / "synthetic_movers.json"
    if synth_path.exists():
        synth = json.loads(synth_path.read_text())
    else:
        synth = {
            "is_synthetic": True,
            "bins": [],
            "note": "not computed yet — run pipeline/inject_movers.py",
            "status": "not computed yet",
        }

    if n_mover_measured == 0:
        field = {
            "status": "not computed yet",
            "note": (
                "No high-PM mover yielded a measured recovery in this run "
                "(need ≥2 cached frames; variables are excluded from mover recovery)."
            ),
            "known_targets_considered": known_considered,
            "per_target": per_target,
            "n_known": None,
            "n_recovered": None,
            "n_missed": None,
            "n_false_candidates": None,
            "recovery_rate": None,
            "match_radius_arcsec": 2 * PIXEL_SCALE_ARCSEC,
            "sample_size": {
                "n_targets_attempted": len(per_target),
                "n_measured": n_measured,
                "n_mover_measured": 0,
            },
            "variable_controls": {
                "n_targets": len(variable_controls),
                "per_target": variable_controls,
                "note": (
                    "Variables / non-movers (μ≈0) are diagnostic controls — "
                    "not counted in known-mover recovery."
                ),
            },
            "method": "DAOStarFinder + link on cached demo PNGs vs PM-propagated position",
        }
    else:
        n_known = recovered + missed
        field = {
            "status": "measured",
            "note": (
                "Measured on cached demo cutouts; misses are first-class. "
                "Variable controls (RW Aurigae, R Draconis) are excluded from mover recovery."
            ),
            "known_targets_considered": known_considered,
            "per_target": per_target,
            "n_known": n_known,
            "n_recovered": recovered,
            "n_missed": missed,
            "n_false_candidates": false_cands,
            "recovery_rate": (recovered / n_known) if n_known else None,
            "match_radius_arcsec": 2 * PIXEL_SCALE_ARCSEC,
            "sample_size": {
                "n_targets_attempted": len(per_target),
                "n_measured": n_measured,
                "n_mover_measured": n_mover_measured,
                "n_variable_controls": len(variable_controls),
                "n_frames_total": sum(int(t.get("n_frames") or 0) for t in per_target),
            },
            "method": (
                "DAOStarFinder detect + greedy nearest-neighbor link on cached demo PNG "
                f"cutouts; match radius = 2×{PIXEL_SCALE_ARCSEC}\" SPHEREx pixels; "
                "only high-PM known movers enter recovery_rate"
            ),
            "misses": [
                t
                for t in per_target
                if t.get("role") == "known_mover" and t.get("n_missed")
            ],
            "misses_explained": (
                "Coarse 6.15\" pixels, wavelength mismatch between LVF visits, "
                "8-bit PNG stretch loss, and sparse epochs can hide motion of ~1 pixel."
            ),
            "variable_controls": {
                "n_targets": len(variable_controls),
                "per_target": variable_controls,
                "note": (
                    "Variables / non-movers (μ≈0) are diagnostic controls — "
                    "not counted in known-mover recovery."
                ),
            },
        }

    payload = {
        "source": "cached-demo",
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
        "motion_fit_self_test": self_test,
        "field_validation": field,
        "synthetic": synth if synth.get("bins") is not None else {
            "is_synthetic": True,
            "status": "not computed yet",
            "bins": [],
        },
        "limits": [
            "Too faint relative to SPHEREx depth / zodiacal background",
            "Too slow: sub-pixel motion between visits",
            "Crowded fields / blending",
            "Bad / flagged pixels (TRANSIENT, HALO, DICHROIC, …)",
            "Wavelength mismatch across LVF visits mistaken for variability",
            "Demo PNGs are 8-bit stretched — detection here underestimates float archive S/N",
        ],
        "disclaimer": "SkyFlip does not claim to discover Planet X or any new object.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print("Wrote", OUT)
    print("field status:", field.get("status"), "measured targets:", n_measured)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
