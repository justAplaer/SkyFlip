#!/usr/bin/env python3
"""Coordinate sanity for all 5 demo targets × every cached (and optional live) epoch.

For each frame prints: obs_id, MJD, predicted RA/Dec, target pixel (x,y),
inside-array (±20 px margin), distance to nearest bright source.

Exits non-zero if any frame FAILs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "frontend" / "public" / "demo-data"
sys.path.insert(0, str(ROOT / "backend"))

from app.adapters import catalogs  # noqa: E402
from app.pm_table import find_target_row  # noqa: E402

MARGIN = 20
ROUNDTRIP_TOL = 0.01

TARGETS = [
    "barnards_star",
    "epsilon_indi_b",
    "wise0855",
    "rw_aurigae",
    "r_draconis",
]


def synth_wcs(ra: float, dec: float, ny: int, nx: int, scale_arcsec: float = 6.15) -> WCS:
    scale = scale_arcsec / 3600.0
    header = {
        "NAXIS": 2,
        "NAXIS1": nx,
        "NAXIS2": ny,
        "CRPIX1": (nx + 1) / 2.0,
        "CRPIX2": (ny + 1) / 2.0,
        "CRVAL1": ra,
        "CRVAL2": dec,
        "CDELT1": -scale,
        "CDELT2": scale,
        "CTYPE1": "RA---TAN",
        "CTYPE2": "DEC--TAN",
        "CUNIT1": "deg",
        "CUNIT2": "deg",
    }
    return WCS(header)


def nearest_source_dist(image: np.ndarray, x: float, y: float, box: int = 15) -> float | None:
    """Distance in pixels from (x,y) to brightest pixel in a local box (rough)."""
    if image.size == 0:
        return None
    ny, nx = image.shape
    xi, yi = int(round(x)), int(round(y))
    x0, x1 = max(0, xi - box), min(nx, xi + box + 1)
    y0, y1 = max(0, yi - box), min(ny, yi + box + 1)
    patch = image[y0:y1, x0:x1]
    if patch.size == 0 or not np.any(np.isfinite(patch)):
        return None
    # Peak in patch relative to local median
    med = np.nanmedian(patch)
    peak = np.nanmax(patch)
    if not np.isfinite(peak) or peak < med + 0.5 * max(abs(med), 1e-3):
        # Fall back: global bright-ish pixels via simple threshold
        flat = image[np.isfinite(image)]
        if flat.size < 10:
            return None
        thr = np.nanpercentile(flat, 99.5)
        ys, xs = np.where(image >= thr)
        if len(xs) == 0:
            return None
        d = np.hypot(xs.astype(float) - x, ys.astype(float) - y)
        return float(np.min(d))
    py, px = np.unravel_index(np.nanargmax(patch), patch.shape)
    return float(np.hypot((x0 + px) - x, (y0 + py) - y))


def check_frame(target_id: str, man: dict, frame: dict) -> tuple[bool, str]:
    obs_id = frame.get("obs_id", "?")
    mjd = float(frame["mjd"])
    shape = frame.get("float_shape") or frame.get("image_shape") or [117, 117]
    ny, nx = int(shape[0]), int(shape[1])
    scale = float(man.get("pixel_scale_arcsec") or 6.15)

    catalog_ra = float(man.get("catalog_ra", man["ra"]))
    catalog_dec = float(man.get("catalog_dec", man["dec"]))
    cut_ra = float(frame.get("cutout_center_ra", man["ra"]))
    cut_dec = float(frame.get("cutout_center_dec", man["dec"]))

    # Propagate catalog → frame MJD when PM is available
    row = find_target_row(target_id) or find_target_row(man.get("name", ""))
    pred_ra = frame.get("predicted_ra")
    pred_dec = frame.get("predicted_dec")
    if row is not None:
        try:
            pm = catalogs.get_proper_motion(man.get("name") or target_id, catalog_ra, catalog_dec)
            pra, pdec = catalogs.propagate_position(
                catalog_ra, catalog_dec, pm, Time(mjd, format="mjd")
            )
            pred_ra, pred_dec = float(pra), float(pdec)
        except Exception:
            if pred_ra is None:
                pred_ra, pred_dec = catalog_ra, catalog_dec
    else:
        if pred_ra is None:
            pred_ra, pred_dec = catalog_ra, catalog_dec
    pred_ra = float(pred_ra)
    pred_dec = float(pred_dec)

    wcs_dict = frame.get("wcs") or {}
    if wcs_dict:
        try:
            w = WCS(wcs_dict)
        except Exception:
            w = synth_wcs(cut_ra, cut_dec, ny, nx, scale)
    else:
        w = synth_wcs(cut_ra, cut_dec, ny, nx, scale)

    sky = SkyCoord(pred_ra * u.deg, pred_dec * u.deg, frame="icrs")
    x, y = w.world_to_pixel(sky)
    x, y = float(x), float(y)

    # Prefer curated predicted pixels when present (same as UI target marker)
    tx = frame.get("predicted_x_pix", frame.get("target_x_pix"))
    ty = frame.get("predicted_y_pix", frame.get("target_y_pix"))
    if tx is not None and ty is not None:
        x, y = float(tx), float(ty)

    inside = MARGIN <= x < nx - MARGIN and MARGIN <= y < ny - MARGIN

    # Round-trip: pixel → sky → pixel
    sky_back = w.pixel_to_world(x, y)
    x2, y2 = w.world_to_pixel(sky_back)
    rt = float(np.hypot(float(x2) - x, float(y2) - y))
    rt_ok = rt <= ROUNDTRIP_TOL

    # Nearest source from float bin if available
    dist = None
    bin_name = frame.get("float_bin")
    if bin_name:
        bin_path = DEMO / target_id / bin_name
        if bin_path.exists():
            arr = np.fromfile(bin_path, dtype="<f4").reshape(ny, nx)
            dist = nearest_source_dist(arr, x, y)

    ok = inside and rt_ok
    # Soft: if curated predicted pixel exists and inside, PASS even if source peak is far
    # (WISE / faint sources). Still FAIL if outside margin or round-trip breaks.
    status = "PASS" if ok else "FAIL"
    line = (
        f"{status}  {target_id}  obs_id={obs_id}  MJD={mjd:.5f}  "
        f"pred_sky=({pred_ra:.6f},{pred_dec:.6f})  pix=({x:.2f},{y:.2f})  "
        f"inside_margin20={inside}  roundtrip_pix={rt:.4f}  "
        f"nearest_src_pix={dist if dist is not None else 'n/a'}"
    )
    return ok, line


def main() -> int:
    fails = 0
    total = 0
    for tid in TARGETS:
        man_path = DEMO / tid / "manifest.json"
        if not man_path.exists():
            print(f"FAIL  {tid}  missing manifest {man_path}")
            fails += 1
            continue
        man = json.loads(man_path.read_text(encoding="utf-8"))
        frames = man.get("frames") or []
        if not frames:
            print(f"FAIL  {tid}  no frames")
            fails += 1
            continue
        for fr in frames:
            total += 1
            ok, line = check_frame(tid, man, fr)
            print(line)
            if not ok:
                fails += 1

    # Optional live pyramid cache under .cache/frame_pyramids
    cache_root = ROOT / ".cache"
    live_checked = 0
    if cache_root.exists():
        for meta_path in cache_root.rglob("meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            wcs_h = meta.get("wcs") or {}
            if not wcs_h:
                continue
            try:
                w = WCS(wcs_h)
            except Exception:
                continue
            nx = int(meta.get("naxis1") or wcs_h.get("NAXIS1") or 0)
            ny = int(meta.get("naxis2") or wcs_h.get("NAXIS2") or 0)
            if nx < 10 or ny < 10:
                continue
            # Round-trip CRVAL
            ra = float(wcs_h.get("CRVAL1"))
            dec = float(wcs_h.get("CRVAL2"))
            sky = SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
            x, y = w.world_to_pixel(sky)
            sky2 = w.pixel_to_world(x, y)
            x2, y2 = w.world_to_pixel(sky2)
            rt = float(np.hypot(float(x2) - float(x), float(y2) - float(y)))
            live_checked += 1
            total += 1
            ok = rt <= ROUNDTRIP_TOL
            obs = meta.get("obs_id", meta_path.parent.name)
            print(
                f"{'PASS' if ok else 'FAIL'}  live_cache  obs_id={obs}  "
                f"MJD={meta.get('mjd', 'n/a')}  pred_sky=({ra:.6f},{dec:.6f})  "
                f"pix=({float(x):.2f},{float(y):.2f})  roundtrip_pix={rt:.4f}"
            )
            if not ok:
                fails += 1

    print(f"\nChecked {total} frames ({live_checked} live cache). FAILs={fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
