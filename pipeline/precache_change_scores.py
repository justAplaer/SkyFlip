#!/usr/bin/env python3
"""Precompute change_scores.json for each demo target (offline Change Slider)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.cache import DEMO_DATA, write_json  # noqa: E402
from app.change_scores import (  # noqa: E402
    DEFAULT_WAVELENGTH_TOL_UM,
    load_demo_frame_inputs,
    net_motion,
    score_frames,
    wavelength_match_summary,
)

TARGETS = [
    "wise0855",
    "barnards_star",
    "epsilon_indi_b",
    "rw_aurigae",
    "r_draconis",
]
METRICS = ("brightness_snr", "position_shift", "combined")
REFERENCES = ("median_others", "first_epoch", "previous_epoch")
RADIUS = 1.5


def main() -> None:
    for tid in TARGETS:
        demo_dir = DEMO_DATA / tid
        man_path = demo_dir / "manifest.json"
        if not man_path.exists():
            print(f"skip {tid}: no manifest")
            continue

        man = json.loads(man_path.read_text(encoding="utf-8"))
        # Score at cutout CRVAL (SPHEREx-era); PM preds live on that grid.
        ra = float(man["ra"])
        dec = float(man["dec"])
        frames, ax, ay = load_demo_frame_inputs(
            demo_dir, ra=ra, dec=dec, target_ra=ra, target_dec=dec
        )
        by_key: dict = {}
        default_payload = None
        for metric in METRICS:
            for reference in REFERENCES:
                scores = score_frames(
                    frames,
                    metric=metric,  # type: ignore[arg-type]
                    reference=reference,  # type: ignore[arg-type]
                    aperture_pix=RADIUS,
                    wavelength_tol_um=DEFAULT_WAVELENGTH_TOL_UM,
                    use_motion_window=True,
                )
                wl = wavelength_match_summary(
                    scores, wavelength_tol_um=DEFAULT_WAVELENGTH_TOL_UM
                )
                motion = net_motion(scores)
                if wl["too_few_wavelength_matched_frames"]:
                    motion = {
                        "status": "too_few_wavelength_matched_frames",
                        "message": "too few wavelength-matched frames",
                        "pm_arcsec_yr": None,
                        "pm_arcsec_yr_err": None,
                    }
                n_assist = sum(
                    1 for f in (man.get("frames") or []) if f.get("png_display_assist")
                )
                note = (
                    "Precomputed from demo float bins at PM-predicted pixels; "
                    "Bug 7 motion-windowed centroids; VARIANCE not packed — "
                    "brightness S/N uses annulus scatter when needed. "
                    "Wavelength-mismatched frames excluded from ranking. "
                    "Candidates only — not a discovery."
                )
                if n_assist:
                    note += (
                        f" {n_assist} PNG display-assist frame(s) in the pack — "
                        "float IMAGE may still be saturation-blanked."
                    )
                payload = {
                    "ra": ra,
                    "dec": dec,
                    "catalog_ra": man.get("catalog_ra"),
                    "catalog_dec": man.get("catalog_dec"),
                    "radius_pix": RADIUS,
                    "metric": metric,
                    "reference": reference,
                    "aperture_x_pix": ax,
                    "aperture_y_pix": ay,
                    "use_motion_window": True,
                    "frames": [s.to_dict() for s in scores],
                    "motion": motion,
                    "is_synthetic": False,
                    "source": "cached-demo",
                    "wavelength_tol_um": wl["wavelength_tol_um"],
                    "n_wavelength_excluded": wl["n_wavelength_excluded"],
                    "wavelength_status": wl["wavelength_status"],
                    "wavelength_message": wl["message"],
                    "note": note,
                }
                by_key[f"{metric}|{reference}|{RADIUS}"] = payload
                if metric == "brightness_snr" and reference == "median_others":
                    default_payload = payload
        out = {
            "target_id": tid,
            "ra": ra,
            "dec": dec,
            "catalog_ra": man.get("catalog_ra"),
            "catalog_dec": man.get("catalog_dec"),
            "default": default_payload,
            "by_key": by_key,
        }
        out_path = demo_dir / "change_scores.json"
        write_json(out_path, out)
        n = len(default_payload["frames"]) if default_payload else 0
        mot = (default_payload or {}).get("motion") or {}
        print(
            f"wrote {out_path} ({n} frames) "
            f"motion={mot.get('status')} pm={mot.get('pm_arcsec_yr')}"
        )


if __name__ == "__main__":
    main()
