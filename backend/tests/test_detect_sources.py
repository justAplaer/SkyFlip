"""detect_sources must work with current photutils column names."""

from __future__ import annotations

import numpy as np
from astropy.wcs import WCS

from app.detect import detect_sources


def _simple_wcs(shape=(64, 64)) -> WCS:
    w = WCS(naxis=2)
    w.wcs.crpix = [shape[1] / 2, shape[0] / 2]
    w.wcs.cdelt = [-6.15 / 3600.0, 6.15 / 3600.0]
    w.wcs.crval = [180.0, 0.0]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def test_detect_sources_finds_four_synthetic_stars():
    # Flat background + bright Gaussians so DAOStarFinder returns exactly 4.
    shape = (80, 80)
    img = np.full(shape, 1.0, dtype=float)
    positions = [(20.0, 20.0), (60.0, 20.0), (20.0, 60.0), (55.0, 55.0)]
    yy, xx = np.indices(shape)
    for x0, y0 in positions:
        img += 80.0 * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * 1.5**2))
    # Tiny noise so sigma is nonzero but well below sources
    rng = np.random.default_rng(0)
    img += rng.normal(0.0, 0.05, size=shape)

    dets = detect_sources(
        img,
        _simple_wcs(shape),
        epoch_id="synth",
        mjd=60000.0,
        fwhm=3.0,
        threshold_sigma=5.0,
    )
    assert len(dets) == 4, f"expected 4 detections, got {len(dets)}: {[(d.x, d.y) for d in dets]}"
    for x0, y0 in positions:
        assert any(np.hypot(d.x - x0, d.y - y0) < 2.0 for d in dets)
