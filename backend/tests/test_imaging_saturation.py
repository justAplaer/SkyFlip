"""Saturation display helpers for blanked SPHEREx L2 cores."""

from __future__ import annotations

import numpy as np

from app.adapters.catalogs import _coerce_ref_epoch, propagate_position
from app.imaging import accent_saturation_flags, pm_predicted_display_stamp
from astropy.time import Time


def test_accent_saturation_flags_boosts_halo():
    img = np.ones((21, 21), dtype=float) * 0.3
    flags = np.zeros((21, 21), dtype=np.int64)
    flags[10, 10] = 1 << 28  # HALO
    flags[0, 0] = 1 << 1  # distant OVERFLOW
    out = accent_saturation_flags(img, flags, near_xy=(10.0, 10.0), near_radius_pix=5.0)
    assert out[10, 10] > img[10, 10]
    assert out[0, 0] == img[0, 0]  # outside radius — not boosted


def test_pm_stamp_raises_local_peak():
    img = np.ones((31, 31), dtype=float) * 0.2
    out = pm_predicted_display_stamp(img, 15.0, 15.0, amplitude=5.0)
    assert out[15, 15] >= 5.0 * 0.9
    assert out[0, 0] == 0.2


def test_coerce_ref_epoch_string():
    t = _coerce_ref_epoch("2016.0")
    assert abs(t.decimalyear - 2016.0) < 1e-6


def test_propagate_accepts_string_epoch():
    pra, pdec = propagate_position(
        269.4520769586187,
        4.69336496657667,
        {
            "pm_ra_cosdec_arcsec_yr": -0.801551,
            "pm_dec_arcsec_yr": 10.362394,
            "ref_epoch": "2016.0",
        },
        Time(61099.73, format="mjd"),
    )
    assert pdec > 4.69336496657667
    assert abs(pra - 269.45) < 0.01
