#!/usr/bin/env python3
"""Inject synthetic Gaussian-PSF movers into real demo cutout backgrounds and measure recovery."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from astropy.wcs import WCS
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.adapters.spherex import PIXEL_SCALE_ARCSEC  # noqa: E402
from app.detect import detect_sources, link_detections  # noqa: E402
from app.validate import synthetic_recovery_curve  # noqa: E402

OUT = ROOT / "frontend" / "public" / "demo-data" / "synthetic_movers.json"
DEMO = ROOT / "frontend" / "public" / "demo-data"


def gaussian_blob(shape, x, y, amp=5.0, fwhm=2.0):
    yy, xx = np.indices(shape)
    s = fwhm / 2.355
    return amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))


def _tan_wcs(ra: float, dec: float, shape: tuple[int, int]) -> WCS:
    ny, nx = shape
    w = WCS(naxis=2)
    w.wcs.crpix = [nx / 2.0, ny / 2.0]
    scale = PIXEL_SCALE_ARCSEC / 3600.0
    w.wcs.cdelt = [-scale, scale]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def _center_crop(arr: np.ndarray, ny: int, nx: int) -> np.ndarray:
    """Center-crop (or pad) to a common shape so multi-epoch stacks align."""
    ay, ax = arr.shape
    out = np.zeros((ny, nx), dtype=float)
    y0 = max(0, (ay - ny) // 2)
    x0 = max(0, (ax - nx) // 2)
    oy = max(0, (ny - ay) // 2)
    ox = max(0, (nx - ax) // 2)
    h = min(ay - y0, ny - oy)
    w = min(ax - x0, nx - ox)
    out[oy : oy + h, ox : ox + w] = arr[y0 : y0 + h, x0 : x0 + w]
    return out


def _background_stack(tid: str = "rw_aurigae") -> tuple[list[np.ndarray], list[float], float, float]:
    man = json.loads((DEMO / tid / "manifest.json").read_text())
    raw = []
    mjds = []
    for fr in man["frames"]:
        png = DEMO / tid / fr["png"]
        raw.append(np.asarray(Image.open(png).convert("L"), dtype=float))
        mjds.append(float(fr["mjd"]))
    # SPHEREx edge cutouts can be ragged; use common min dimensions.
    ny = min(a.shape[0] for a in raw)
    nx = min(a.shape[1] for a in raw)
    frames = [_center_crop(a, ny, nx) for a in raw]
    return frames, mjds, float(man["ra"]), float(man["dec"])


def _run_bin(
    backgrounds: list[np.ndarray],
    mjds: list[float],
    ra: float,
    dec: float,
    *,
    amp: float,
    dx_per_epoch: float,
    dy_per_epoch: float,
    seed: int,
) -> dict:
    rng = np.random.default_rng(seed)
    shape = backgrounds[0].shape
    x0 = shape[1] / 2.0 - dx_per_epoch * (len(backgrounds) - 1) / 2.0
    y0 = shape[0] / 2.0 - dy_per_epoch * (len(backgrounds) - 1) / 2.0
    per_epoch = []
    truth = []
    for i, (bg, mjd) in enumerate(zip(backgrounds, mjds)):
        img = np.asarray(bg, dtype=float).copy() + rng.normal(0.0, 0.5, size=bg.shape)
        x = x0 + i * dx_per_epoch
        y = y0 + i * dy_per_epoch
        img += gaussian_blob(bg.shape, x, y, amp=amp, fwhm=2.2)
        wcs = _tan_wcs(ra, dec, bg.shape)
        dets = detect_sources(img, wcs, f"inj_{i}", mjd, fwhm=2.5, threshold_sigma=3.5)
        per_epoch.append(dets)
        truth.append({"x": x, "y": y, "mjd": mjd})

    tracks = link_detections(per_epoch, max_sep_arcsec=4 * PIXEL_SCALE_ARCSEC, min_epochs=2)
    # Recovered if any track passes near truth mean within 2 pixels
    recovered = False
    for tr in tracks:
        if len(tr.detections) < 2:
            continue
        mx = np.mean([d.x for d in tr.detections])
        my = np.mean([d.y for d in tr.detections])
        tx = np.mean([t["x"] for t in truth])
        ty = np.mean([t["y"] for t in truth])
        if np.hypot(mx - tx, my - ty) < 2.5:
            recovered = True
            break

    dt_yr = (mjds[-1] - mjds[0]) / 365.25 if len(mjds) > 1 else 1.0
    speed_pix = float(np.hypot(dx_per_epoch, dy_per_epoch) * (len(mjds) - 1))
    speed_arcsec_yr = (speed_pix * PIXEL_SCALE_ARCSEC / dt_yr) if dt_yr > 0 else None
    return {
        "brightness_amp": amp,
        "dx_pix_per_epoch": dx_per_epoch,
        "dy_pix_per_epoch": dy_per_epoch,
        "speed_arcsec_yr": speed_arcsec_yr,
        "n_epochs": len(mjds),
        "n_tracks": len(tracks),
        "recovered": recovered,
        "is_synthetic": True,
        "seed": seed,
    }


def main() -> int:
    try:
        backgrounds, mjds, ra, dec = _background_stack("rw_aurigae")
    except Exception as exc:
        payload = {
            "is_synthetic": True,
            "status": "not computed yet",
            "bins": [],
            "note": f"Could not load demo backgrounds: {exc}",
            "badge": "SIMULATED / TEST DATA",
        }
        OUT.write_text(json.dumps(payload, indent=2) + "\n")
        print("Wrote", OUT, "(not computed)")
        return 0

    bins_spec = [
        ("bright", 40.0, 2.0, 0.5),
        ("mid", 15.0, 1.2, 0.3),
        ("faint", 6.0, 0.8, 0.2),
        ("slow", 25.0, 0.3, 0.1),
        ("fast", 25.0, 3.0, 1.0),
    ]
    results = []
    for i, (label, amp, dx, dy) in enumerate(bins_spec):
        r = _run_bin(
            backgrounds,
            mjds,
            ra,
            dec,
            amp=amp,
            dx_per_epoch=dx,
            dy_per_epoch=dy,
            seed=1000 + i,
        )
        r["brightness"] = label
        results.append(r)

    n_ok = sum(1 for r in results if r["recovered"])
    payload = {
        **synthetic_recovery_curve(results),
        "status": "measured",
        "badge": "SIMULATED / TEST DATA",
        "is_synthetic": True,
        "background_target": "rw_aurigae",
        "method": (
            "Inject Gaussian PSF movers into real cached RW Aurigae PNG backgrounds; "
            "run DAOStarFinder + link; recover if track mean within 2.5 px of truth"
        ),
        "sample_size": {"n_bins": len(results), "n_recovered": n_ok},
        "recovery_rate": n_ok / len(results) if results else None,
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print("Wrote", OUT, f"recovery {n_ok}/{len(results)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
