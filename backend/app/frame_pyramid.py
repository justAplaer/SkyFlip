"""Full-detector IMAGE pyramid: 256×256 float32 tiles + flag OR-reduction.

Pixels always come from the archive IMAGE (and FLAGS) extension — never
upsampled or invented. Level 0 is native resolution; higher levels are
block-mean (image) / bitwise-OR (flags) downsamples by 2^level.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

logger = logging.getLogger(__name__)

TILE_SIZE = 256
# Level 0 = full; levels 1..N = /2, /4, … until ≈ one tile.
DEFAULT_MAX_LEVEL = 3
# SPHEREx Level-2 Spectral Image detectors are 2040×2040. Cutout fallbacks
# (~0.5° ≈ 293 px) must never be treated as a finished full-frame pyramid.
MIN_FULL_DETECTOR_SIDE = 1500


def is_full_detector_shape(ny: int, nx: int) -> bool:
    """True when both axes look like a whole SPHEREx detector, not an IBE crop."""
    return min(int(ny), int(nx)) >= MIN_FULL_DETECTOR_SIDE


def sanitize_obs_id(obs_id: str) -> str:
    """Filesystem-safe key fragment (obs ids contain letters, digits, underscores)."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", obs_id.strip())
    return cleaned or "unknown"


def level_shape(ny: int, nx: int, level: int) -> tuple[int, int]:
    """Shape of the downsampled array at pyramid level (block size = 2^level)."""
    if level < 0:
        raise ValueError(f"level must be >= 0, got {level}")
    factor = 1 << level
    return (max(1, (ny + factor - 1) // factor), max(1, (nx + factor - 1) // factor))


def num_levels(ny: int, nx: int, tile: int = TILE_SIZE, max_level: int = DEFAULT_MAX_LEVEL) -> int:
    """How many pyramid levels (inclusive of 0) until the whole frame fits in ~1 tile."""
    levels = 1
    h, w = ny, nx
    while levels - 1 < max_level and (h > tile or w > tile):
        h = max(1, (h + 1) // 2)
        w = max(1, (w + 1) // 2)
        levels += 1
    return levels


def tile_grid(ny: int, nx: int, tile: int = TILE_SIZE) -> tuple[int, int]:
    """Number of tiles (nty, ntx) covering an array of shape (ny, nx)."""
    return (max(1, (ny + tile - 1) // tile), max(1, (nx + tile - 1) // tile))


def tile_slice(
    ny: int, nx: int, ty: int, tx: int, tile: int = TILE_SIZE
) -> tuple[slice, slice]:
    """Row/col slices for tile (ty, tx) on an array of shape (ny, nx)."""
    y0 = ty * tile
    x0 = tx * tile
    if y0 >= ny or x0 >= nx or ty < 0 or tx < 0:
        raise IndexError(f"tile ({ty},{tx}) out of range for shape {(ny, nx)}")
    y1 = min(ny, y0 + tile)
    x1 = min(nx, x0 + tile)
    return slice(y0, y1), slice(x0, x1)


def block_mean_downsample(image: np.ndarray, factor: int) -> np.ndarray:
    """Mean of each factor×factor block; NaN-aware (nanmean). factor must be power of 2 ≥ 1."""
    if factor == 1:
        return np.asarray(image, dtype=np.float32)
    if factor < 1 or (factor & (factor - 1)) != 0:
        raise ValueError(f"factor must be power of 2 >= 1, got {factor}")
    arr = np.asarray(image, dtype=np.float64)
    ny, nx = arr.shape
    out_y = ny // factor
    out_x = nx // factor
    if out_y < 1 or out_x < 1:
        # Degenerate: mean of whatever remains
        return np.asarray([[np.nanmean(arr)]], dtype=np.float32)
    trimmed = arr[: out_y * factor, : out_x * factor]
    reshaped = trimmed.reshape(out_y, factor, out_x, factor)
    with np.errstate(all="ignore"):
        out = np.nanmean(reshaped, axis=(1, 3))
    return out.astype(np.float32)


def block_or_downsample(flags: np.ndarray, factor: int) -> np.ndarray:
    """Bitwise OR of each factor×factor block (for flag tiles at level > 0)."""
    if factor == 1:
        return np.asarray(flags)
    arr = np.asarray(flags)
    ny, nx = arr.shape
    out_y = ny // factor
    out_x = nx // factor
    if out_y < 1 or out_x < 1:
        return np.asarray([[int(np.bitwise_or.reduce(arr.ravel()))]], dtype=arr.dtype)
    trimmed = arr[: out_y * factor, : out_x * factor]
    reshaped = trimmed.reshape(out_y, factor, out_x, factor)
    # Reduce over the two block axes
    out = reshaped[:, 0, :, 0].copy()
    for iy in range(factor):
        for ix in range(factor):
            if iy == 0 and ix == 0:
                continue
            out = np.bitwise_or(out, reshaped[:, iy, :, ix])
    return out


def robust_stats(image: np.ndarray) -> dict[str, float]:
    """Percentiles + simple zscale-like limits from finite pixels only."""
    flat = np.asarray(image, dtype=np.float64).ravel()
    finite = flat[np.isfinite(flat)]
    if finite.size == 0:
        return {
            "p01": float("nan"),
            "p50": float("nan"),
            "p995": float("nan"),
            "z1": float("nan"),
            "z2": float("nan"),
        }
    p01, p50, p995 = np.percentile(finite, [1.0, 50.0, 99.5])
    # IRAF-like soft zscale: ~0.25–99.75 with mid bias; enough for display defaults.
    z1, z2 = np.percentile(finite, [0.5, 99.5])
    return {
        "p01": float(p01),
        "p50": float(p50),
        "p995": float(p995),
        "z1": float(z1),
        "z2": float(z2),
    }


def extract_tile(arr: np.ndarray, ty: int, tx: int, tile: int = TILE_SIZE) -> np.ndarray:
    """Return a contiguous tile array (may be smaller than tile×tile at edges)."""
    ny, nx = arr.shape
    ys, xs = tile_slice(ny, nx, ty, tx, tile)
    return np.ascontiguousarray(arr[ys, xs])


@dataclass
class PyramidMeta:
    obs_id: str
    detector: int
    shape: tuple[int, int]  # (ny, nx)
    tile_size: int
    n_levels: int
    subtract_zodi: bool
    bunit: str
    source_url: str
    mjd: float
    time_iso: str
    bandpass: str
    wcs_header: dict[str, Any]
    stats: dict[str, float]
    central_wavelength_um: Optional[float] = None
    bandwidth_um: Optional[float] = None
    collection: str = ""
    cache_key: str = ""

    def to_dict(self) -> dict[str, Any]:
        ny, nx = self.shape
        return {
            "obs_id": self.obs_id,
            "detector": self.detector,
            "shape": [int(ny), int(nx)],
            "naxis1": int(nx),
            "naxis2": int(ny),
            "tile_size": self.tile_size,
            "n_levels": self.n_levels,
            "subtract_zodi": self.subtract_zodi,
            "bunit": self.bunit,
            "source_url": self.source_url,
            "mjd": self.mjd,
            "time_iso": self.time_iso,
            "bandpass": self.bandpass,
            "wcs": self.wcs_header,
            "stats": self.stats,
            "central_wavelength_um": self.central_wavelength_um,
            "bandwidth_um": self.bandwidth_um,
            "collection": self.collection,
            "cache_key": self.cache_key,
        }


def pyramid_dir(
    cache_root: Path,
    obs_id: str,
    detector: int,
    *,
    subtract_zodi: bool,
) -> Path:
    zflag = "zodi1" if subtract_zodi else "zodi0"
    return cache_root / "frames" / sanitize_obs_id(obs_id) / f"D{int(detector)}" / zflag


def write_pyramid(
    cache_root: Path,
    *,
    obs_id: str,
    detector: int,
    image: np.ndarray,
    flags: np.ndarray,
    subtract_zodi: bool,
    meta: PyramidMeta,
) -> Path:
    """Materialize all pyramid levels as .f32 / .flags tiles + meta.json."""
    root = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    root.mkdir(parents=True, exist_ok=True)
    ny, nx = image.shape
    n_levels = meta.n_levels
    img0 = np.asarray(image, dtype=np.float32)
    fl0 = np.asarray(flags)

    for level in range(n_levels):
        factor = 1 << level
        if level == 0:
            img_l = img0
            fl_l = fl0
        else:
            img_l = block_mean_downsample(img0, factor)
            fl_l = block_or_downsample(fl0, factor)
        ly, lx = img_l.shape
        nty, ntx = tile_grid(ly, lx)
        level_dir = root / f"L{level}"
        level_dir.mkdir(parents=True, exist_ok=True)
        # Persist level array once for fast tile slicing (memory-map friendly).
        img_path = level_dir / "image.f32"
        fl_path = level_dir / "flags.i32"
        img_l.astype(np.float32).tofile(img_path)
        # Store flags as int32 (IRSA FLAGS can be large bitfields).
        fl_l.astype(np.int32).tofile(fl_path)
        (level_dir / "shape.json").write_text(
            json.dumps({"ny": ly, "nx": lx, "nty": nty, "ntx": ntx}),
            encoding="utf-8",
        )

    meta_path = root / "meta.json"
    meta.cache_key = str(root.relative_to(cache_root)) if cache_root in root.parents or root == cache_root else str(root)
    meta_path.write_text(json.dumps(meta.to_dict(), indent=2, default=str), encoding="utf-8")
    return root


def load_meta(cache_root: Path, obs_id: str, detector: int, *, subtract_zodi: bool) -> Optional[dict[str, Any]]:
    path = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi) / "meta.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def read_image_tile(
    cache_root: Path,
    obs_id: str,
    detector: int,
    level: int,
    ty: int,
    tx: int,
    *,
    subtract_zodi: bool,
) -> bytes:
    """Return little-endian float32 tile bytes (NaN preserved)."""
    root = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    level_dir = root / f"L{level}"
    shape = json.loads((level_dir / "shape.json").read_text(encoding="utf-8"))
    ny, nx = int(shape["ny"]), int(shape["nx"])
    arr = np.fromfile(level_dir / "image.f32", dtype=np.float32).reshape(ny, nx)
    tile = extract_tile(arr, ty, tx)
    return tile.astype("<f4").tobytes()


def read_flags_tile(
    cache_root: Path,
    obs_id: str,
    detector: int,
    level: int,
    ty: int,
    tx: int,
    *,
    subtract_zodi: bool,
) -> bytes:
    """Return little-endian int32 flag tile bytes."""
    root = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    level_dir = root / f"L{level}"
    shape = json.loads((level_dir / "shape.json").read_text(encoding="utf-8"))
    ny, nx = int(shape["ny"]), int(shape["nx"])
    arr = np.fromfile(level_dir / "flags.i32", dtype=np.int32).reshape(ny, nx)
    tile = extract_tile(arr, ty, tx)
    return tile.astype("<i4").tobytes()


def pyramid_ready(cache_root: Path, obs_id: str, detector: int, *, subtract_zodi: bool) -> bool:
    root = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    if not ((root / "meta.json").exists() and (root / "L0" / "image.f32").exists()):
        return False
    meta = load_meta(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    if not meta:
        return False
    shape = meta.get("shape") or [meta.get("naxis2"), meta.get("naxis1")]
    try:
        ny, nx = int(shape[0]), int(shape[1])
    except (TypeError, ValueError, IndexError):
        return False
    if not is_full_detector_shape(ny, nx):
        logger.warning(
            "rejecting undersized full-frame pyramid %s D%s (%s×%s) — likely a cutout fallback",
            obs_id,
            detector,
            nx,
            ny,
        )
        return False
    return True


def clear_pyramid(cache_root: Path, obs_id: str, detector: int, *, subtract_zodi: bool) -> None:
    """Remove a pyramid directory (e.g. after rejecting a cutout-sized cache)."""
    import shutil

    root = pyramid_dir(cache_root, obs_id, detector, subtract_zodi=subtract_zodi)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
