"""Weighted motion fit must apply 1/σ² once (not twice)."""

from __future__ import annotations

import numpy as np

from app.detect import Detection, Track, fit_linear_motion


def test_fit_weights_applied_once_recovers_known_slope():
    """Heteroscedastic points: equal-weight fit is biased; single 1/σ² recovers truth."""
    # True slope 2.0 deg/yr in RA. Last point is a large outlier with huge σ so
    # correct inverse-variance weighting must ignore it.
    t0 = 60000.0
    true_pm_deg_yr = 2.0
    mjds = [t0 + i * 365.25 for i in range(4)]
    ras = [10.0 + true_pm_deg_yr * i for i in range(4)]
    ras[3] = 10.0 + true_pm_deg_yr * 3 + 20.0  # +20° outlier at last epoch
    # Good points ~0.01", outlier ~200".
    pix_errs = [0.01 / 6.15, 0.01 / 6.15, 0.01 / 6.15, 200.0 / 6.15]
    dets = [
        Detection(
            epoch_id=f"e{i}",
            mjd=mjds[i],
            x=0.0,
            y=0.0,
            ra=ras[i],
            dec=0.0,
            flux=1.0,
            x_err=pix_errs[i],
            y_err=0.2,
        )
        for i in range(4)
    ]
    tr = fit_linear_motion(Track("t", dets))
    recovered = float(tr.pm_ra_arcsec_yr or 0.0) / 3600.0
    assert abs(recovered - true_pm_deg_yr) < 0.25, (recovered, tr.pm_ra_arcsec_yr)
    t = np.array([0.0, 1.0, 2.0, 3.0])
    unweighted = float(np.polyfit(t, ras, 1)[0])
    assert abs(unweighted - true_pm_deg_yr) > 1.0


def test_classify_requires_three_epochs_for_candidate():
    from app.classify import classify_track

    # Two-epoch significant mover → not candidate
    dets = []
    for i in range(2):
        mjd = 60000.0 + i * 365.25
        dets.append(
            Detection(
                epoch_id=f"e{i}",
                mjd=mjd,
                x=0,
                y=0,
                ra=10.0 + i * (10.0 / 3600.0),  # 10"/yr
                dec=0.0,
                flux=1.0,
                x_err=0.05,
                y_err=0.05,
            )
        )
    tr = fit_linear_motion(Track("t", dets))
    cls = classify_track(tr, crossmatch={"status": "no_match"})
    assert cls["classification"] != "candidate", cls
    assert any("3" in r or "epochs" in r for r in cls["reasons"])
