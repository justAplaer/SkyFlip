"""Sky-position matching for demo-cache safety.

Cached demo frames may only be served when the request center matches the
manifest center within a small tolerance. Never show another field's pixels.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

# ~72″ — small vs typical 0.15–0.2° demo FOV; not a science match radius.
CACHE_POSITION_TOL_DEG = 0.02


def positions_match(
    ra_a: float,
    dec_a: float,
    ra_b: float,
    dec_b: float,
    *,
    tol_deg: float = CACHE_POSITION_TOL_DEG,
) -> bool:
    """True if two ICRS centers agree within ``tol_deg`` (small-angle approx)."""
    if not all(math.isfinite(x) for x in (ra_a, dec_a, ra_b, dec_b, tol_deg)):
        return False
    if tol_deg < 0:
        return False
    mid_dec = 0.5 * (dec_a + dec_b)
    cosd = max(math.cos(math.radians(mid_dec)), 1e-6)
    dra = (ra_a - ra_b) * cosd
    ddec = dec_a - dec_b
    return math.hypot(dra, ddec) <= tol_deg


def manifest_center_match(
    ra: float,
    dec: float,
    man: Mapping[str, Any],
    *,
    tol_deg: float = CACHE_POSITION_TOL_DEG,
) -> bool:
    """Match request to cutout CRVAL and/or catalog-epoch coords.

    High-PM packs store SPHEREx-era ``ra``/``dec`` (cutout center) and keep
    Gaia/WISE epoch under ``catalog_ra``/``catalog_dec``. Resolve still returns
    catalog coords, so both must unlock the same demo cache.
    """
    candidates: list[tuple[float, float]] = []
    for rk, dk in (("ra", "dec"), ("catalog_ra", "catalog_dec")):
        if rk not in man or dk not in man:
            continue
        try:
            candidates.append((float(man[rk]), float(man[dk])))
        except (TypeError, ValueError):
            continue
    return any(positions_match(ra, dec, cra, cdec, tol_deg=tol_deg) for cra, cdec in candidates)
