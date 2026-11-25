"""Alignment, stacking, and differencing of SPHEREx cutouts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp


@dataclass
class Frame:
    image: np.ndarray
    wcs: WCS
    variance: Optional[np.ndarray] = None
    flags: Optional[np.ndarray] = None
    mjd: float = 0.0
    label: str = ""


def percentile_clip(data: np.ndarray, lo: float = 1.0, hi: float = 99.0) -> tuple[float, float]:
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return 0.0, 1.0
    return float(np.percentile(finite, lo)), float(np.percentile(finite, hi))


def stretch(
    data: np.ndarray,
    mode: str = "asinh",
    lo: float = 1.0,
    hi: float = 99.0,
) -> np.ndarray:
    """Return display-scaled array in [0, 1]."""
    vmin, vmax = percentile_clip(data, lo, hi)
    x = np.nan_to_num(data, nan=vmin)
    x = np.clip(x, vmin, vmax)
    if vmax <= vmin:
        return np.zeros_like(x)
    if mode == "linear":
        y = (x - vmin) / (vmax - vmin)
    elif mode == "log":
        y = np.log1p(x - vmin) / np.log1p(vmax - vmin)
    else:  # asinh default
        y = np.arcsinh((x - vmin) / ((vmax - vmin) / 3.0))
        y = y / (np.arcsinh(3.0) + 1e-9)
    return np.clip(y, 0.0, 1.0)


def accent_saturation_flags(
    image: np.ndarray,
    flags: np.ndarray | None,
    *,
    halo_bit: int = 28,
    bloom_bit: int = 26,
    overflow_bit: int = 1,
    near_xy: tuple[float, float] | None = None,
    near_radius_pix: float = 12.0,
) -> np.ndarray:
    """Boost HALO/BLOOM/OVERFLOW pixels so saturated stars remain visible in PNGs.

    SPHEREx L2 may blank early-OVERFLOW cores to NaN/background while FLAGS still
    mark the footprint (Explanatory Supplement Table 16; bright-star bloom notes).
    Float science arrays are unchanged — call this only for display copies.

    When ``near_xy`` is set, only accent flags inside that radius (avoids boosting
    unrelated saturated field stars elsewhere in the cutout).
    """
    out = np.asarray(image, dtype=float).copy()
    if flags is None:
        return out
    fl = np.asarray(flags, dtype=np.int64)
    accent = (
        ((fl & (1 << halo_bit)) != 0)
        | ((fl & (1 << bloom_bit)) != 0)
        | ((fl & (1 << overflow_bit)) != 0)
    )
    if near_xy is not None:
        yy, xx = np.mgrid[0 : out.shape[0], 0 : out.shape[1]]
        accent = accent & (
            np.hypot(xx - float(near_xy[0]), yy - float(near_xy[1])) <= near_radius_pix
        )
    if not np.any(accent):
        return out
    finite = out[np.isfinite(out)]
    if finite.size == 0:
        return out
    peak = float(np.nanpercentile(finite, 99.5))
    floor = float(np.nanmedian(finite))
    boost = max(peak * 4.0, floor + abs(peak - floor) * 4.0, 1.0)
    out[accent] = np.fmax(out[accent], boost)
    return out


def pm_predicted_display_stamp(
    image: np.ndarray,
    x_pix: float,
    y_pix: float,
    *,
    fwhm_pix: float = 2.5,
    amplitude: float | None = None,
) -> np.ndarray:
    """Add a soft Gaussian at the PM-predicted pixel for blink display.

    Used when the IMAGE core is saturation-blanked so the mover would otherwise
    be invisible. Manifests must label this as a display assist — not archive flux.
    """
    out = np.asarray(image, dtype=float).copy()
    ny, nx = out.shape
    if not (np.isfinite(x_pix) and np.isfinite(y_pix)):
        return out
    if x_pix < -2 or y_pix < -2 or x_pix > nx + 1 or y_pix > ny + 1:
        return out
    finite = out[np.isfinite(out)]
    if amplitude is None:
        amplitude = float(np.nanpercentile(finite, 99.9)) if finite.size else 1.0
        amplitude = max(amplitude * 1.5, 1.0)
    sig = max(fwhm_pix / 2.355, 0.8)
    rad = int(np.ceil(3.5 * sig))
    x0, y0 = int(round(x_pix)), int(round(y_pix))
    x1, x2 = max(0, x0 - rad), min(nx, x0 + rad + 1)
    y1, y2 = max(0, y0 - rad), min(ny, y0 + rad + 1)
    if x1 >= x2 or y1 >= y2:
        return out
    yy, xx = np.mgrid[y1:y2, x1:x2]
    gauss = amplitude * np.exp(-0.5 * (((xx - x_pix) / sig) ** 2 + ((yy - y_pix) / sig) ** 2))
    patch = out[y1:y2, x1:x2]
    out[y1:y2, x1:x2] = np.where(np.isfinite(patch), np.fmax(patch, gauss), gauss)
    return out


def reproject_to_wcs(
    image: np.ndarray,
    wcs_in: WCS,
    wcs_out: WCS,
    shape_out: tuple[int, int],
) -> np.ndarray:
    out, _ = reproject_interp((image, wcs_in), wcs_out, shape_out=shape_out)
    return np.asarray(out, dtype=float)


def stack_mean(frames: Iterable[np.ndarray]) -> np.ndarray:
    arr = np.stack([np.asarray(f, dtype=float) for f in frames], axis=0)
    return np.nanmean(arr, axis=0)


def difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.asarray(a, dtype=float) - np.asarray(b, dtype=float)


def align_frames(frames: list[Frame], reference: Frame | None = None) -> list[np.ndarray]:
    """Reproject all frames onto the reference WCS/grid."""
    if not frames:
        return []
    ref = reference or frames[0]
    shape = ref.image.shape
    aligned = []
    for fr in frames:
        if fr is ref:
            aligned.append(np.asarray(fr.image, dtype=float))
        else:
            aligned.append(reproject_to_wcs(fr.image, fr.wcs, ref.wcs, shape))
    return aligned
