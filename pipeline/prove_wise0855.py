#!/usr/bin/env python3
"""
Phase 0 proof: download real SPHEREx cutouts for WISE 0855 and write PNGs.

Coordinates from the challenge statement (only hardcoded RA/Dec allowed):
  RA  08h55m10.831s
  Dec -7d14m42.53s

Usage (from repo root, venv active):
  python pipeline/prove_wise0855.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.visualization import ZScaleInterval

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.adapters.spherex import BANDPASSES, SpherexAdapter  # noqa: E402

# Challenge-given coordinates only.
WISE0855_RA = 15.0 * (8 + 55 / 60 + 10.831 / 3600)  # degrees
WISE0855_DEC = -(7 + 14 / 60 + 42.53 / 3600)

OUT_DIR = ROOT / "tmp" / "phase0_wise0855"
FOV_DEG = 0.05
BANDPASS = "SPHEREx-D1"


def save_png(image: np.ndarray, path: Path, title: str) -> None:
    data = np.asarray(image, dtype=float)
    finite = np.isfinite(data)
    if not np.any(finite):
        raise RuntimeError(f"No finite pixels for {path}")
    interval = ZScaleInterval()
    vmin, vmax = interval.get_limits(data[finite])
    fig, ax = plt.subplots(figsize=(5, 5), dpi=120)
    ax.imshow(data, origin="lower", cmap="gray", vmin=vmin, vmax=vmax)
    ax.set_title(title, fontsize=9)
    ax.set_xlabel("x (cutout pix)")
    ax.set_ylabel("y (cutout pix)")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    adapter = SpherexAdapter(cache_dir=ROOT / "backend" / ".cache")

    print(f"WISE 0855 RA={WISE0855_RA:.8f} Dec={WISE0855_DEC:.8f}")
    print(f"Searching {BANDPASS} via IRSA TAP…")
    obs = adapter.find_observations(
        WISE0855_RA,
        WISE0855_DEC,
        fov_deg=FOV_DEG,
        bandpasses=(BANDPASS,),
    )
    if not obs:
        print("ERROR: no observations found. Live IRSA access failed.")
        return 2

    # Pick first of earliest visit and first of latest visit (distinct MJD days).
    obs_sorted = sorted(obs, key=lambda o: o.mjd)
    early = obs_sorted[0]
    late = obs_sorted[-1]
    chosen = [early]
    if late.mjd - early.mjd > 1.0:
        chosen.append(late)
    else:
        # Still save a second frame if available
        if len(obs_sorted) > 1:
            chosen.append(obs_sorted[1])

    manifest = {
        "target": "WISE 0855",
        "ra": WISE0855_RA,
        "dec": WISE0855_DEC,
        "fov_deg": FOV_DEG,
        "bandpass": BANDPASS,
        "pixel_scale_arcsec": 6.15,
        "n_found": len(obs),
        "frames": [],
        "is_synthetic": False,
        "source": "live",
        "credit": "NASA/JPL-Caltech/IPAC — SPHEREx archive at IRSA",
    }

    for i, o in enumerate(chosen):
        print(f"Fetching cutout {i+1}/{len(chosen)}: {o.obs_id} MJD={o.mjd} {o.time_iso}")
        cut = adapter.fetch_cutout(o)
        # Re-parse with target coords for wavelength
        cut = adapter.parse_cutout_fits(
            cut.fits_path,
            o,
            target_ra=WISE0855_RA,
            target_dec=WISE0855_DEC,
        )
        png = OUT_DIR / f"wise0855_{BANDPASS}_{o.mjd:.5f}.png"
        title = f"WISE 0855 {o.bandpass}\n{o.time_iso or f'MJD {o.mjd}'}  λ≈{cut.central_wavelength_um}"
        save_png(cut.image, png, title)
        fits_copy = OUT_DIR / f"wise0855_{BANDPASS}_{o.mjd:.5f}.fits"
        if cut.fits_path and cut.fits_path.exists():
            fits_copy.write_bytes(cut.fits_path.read_bytes())

        manifest["frames"].append(
            {
                "obs_id": o.obs_id,
                "mjd": o.mjd,
                "time_iso": o.time_iso,
                "bandpass": o.bandpass,
                "detector": o.detector,
                "collection": o.collection,
                "png": str(png.relative_to(ROOT)),
                "fits": str(fits_copy.relative_to(ROOT)),
                "central_wavelength_um": cut.central_wavelength_um,
                "bandwidth_um": cut.bandwidth_um,
                "flag_summary": cut.flag_summary,
                "header_meta": cut.header_meta,
                "image_shape": list(cut.image.shape),
                "bunit": cut.header_meta.get("BUNIT"),
            }
        )
        print(f"  wrote {png} shape={cut.image.shape} wave_um={cut.central_wavelength_um}")

    man_path = OUT_DIR / "manifest.json"
    man_path.write_text(json.dumps(manifest, indent=2, default=str))
    print(f"Wrote {man_path}")
    print(f"Found {len(obs)} {BANDPASS} visits; saved {len(chosen)} epoch PNGs.")
    print("Available bandpasses:", ", ".join(BANDPASSES))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
