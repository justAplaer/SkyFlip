"""Unit tests for SPHEREx adapter helpers (no live network required)."""

from __future__ import annotations

import numpy as np

from app.adapters.spherex import (
    FLAG_BITS,
    PIXEL_SCALE_ARCSEC,
    build_cutout_url,
    summarize_flags,
    _detector_from_bandpass,
)


def test_pixel_scale_matches_verified_docs():
    assert PIXEL_SCALE_ARCSEC == 6.15


def test_build_cutout_url():
    url = build_cutout_url(
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x.fits",
        133.79512917,
        -7.24514722,
        0.05,
    )
    assert url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x.fits?")
    assert "center=133.79512917%2C-7.24514722d" in url or "center=133.79512917,-7.24514722d" in url
    assert "size=0.05" in url


def test_detector_from_bandpass():
    assert _detector_from_bandpass("SPHEREx-D1") == 1
    assert _detector_from_bandpass("SPHEREx-D6") == 6


def test_summarize_flags_counts_bits():
    flags = np.zeros((4, 4), dtype=np.uint32)
    flags[0, 0] = 1 << FLAG_BITS["TRANSIENT"]
    flags[1, 1] = (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["HALO"])
    summary = summarize_flags(flags)
    assert summary["TRANSIENT"] == 1
    assert summary["OVERFLOW"] == 1
    assert summary["HALO"] == 1
    assert summary["total_pixels"] == 16
    assert summary["any_flagged"] == 2
