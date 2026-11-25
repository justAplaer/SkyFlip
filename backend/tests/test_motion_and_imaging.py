import numpy as np

from app.detect import Detection, Track, fit_linear_motion
from app.imaging import difference, stretch
from app.validate import fit_motion_self_test


def test_stretch_range():
    data = np.linspace(0, 100, 100).reshape(10, 10)
    out = stretch(data, "asinh")
    assert out.min() >= 0 and out.max() <= 1


def test_difference():
    a = np.ones((4, 4))
    b = np.zeros((4, 4))
    assert np.allclose(difference(a, b), 1)


def test_fit_motion_self_test():
    r = fit_motion_self_test()
    assert r["is_synthetic"] is True
    assert r["ok"] is True


def test_fit_linear_motion_uncertainty_present():
    dets = [
        Detection("e0", 60000, 1, 1, 10.0, 0.0, 1.0, 0.3, 0.3),
        Detection("e1", 60365, 2, 2, 10.01, 0.01, 1.0, 0.3, 0.3),
    ]
    tr = fit_linear_motion(Track("t", dets))
    assert tr.pm_ra_arcsec_yr is not None
    assert tr.pm_dec_arcsec_yr is not None
