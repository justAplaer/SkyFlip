"""Classifier must use PM significance, not a flat arcsec/yr cut."""

from app.classify import classify_track
from app.detect import Detection, Track, fit_linear_motion


def _track_from_pm(
    *,
    pm_ra: float,
    pm_dec: float,
    noise_arcsec: float = 0.05,
    n: int = 4,
) -> Track:
    """Build a track with given true PM and small centroid noise."""
    ra0, dec0 = 180.0, 0.0
    dets = []
    for i in range(n):
        mjd = 60000.0 + i * 180.0
        dt = (mjd - 60000.0) / 365.25
        ra = ra0 + (pm_ra / 3600.0) * dt
        dec = dec0 + (pm_dec / 3600.0) * dt
        # ~0.2 pix error at 6.15"/pix
        pix_err = max(0.2, noise_arcsec / 6.15)
        dets.append(
            Detection(
                epoch_id=f"e{i}",
                mjd=mjd,
                x=10 + i,
                y=10,
                ra=ra,
                dec=dec,
                flux=10.0,
                x_err=pix_err,
                y_err=pix_err,
            )
        )
    tr = Track(id="t", detections=dets)
    fit_linear_motion(tr)
    return tr


def test_stationary_star_is_stationary_source():
    # Tiny PM within noise → stationary_source (not candidate / likely_artifact)
    tr = _track_from_pm(pm_ra=0.0, pm_dec=0.0, noise_arcsec=0.5)
    cls = classify_track(tr)
    assert cls["classification"] == "stationary_source", cls


def test_real_mover_is_candidate_or_known():
    # Barnard's-Star-scale motion (~10"/yr) over months → significant
    tr = _track_from_pm(pm_ra=-5.0, pm_dec=10.0, noise_arcsec=0.3)
    cls = classify_track(tr)
    assert cls["classification"] in {"candidate", "known"}, cls
    assert (cls.get("significance") or 0) >= 3.0


def test_crossmatch_still_known():
    tr = _track_from_pm(pm_ra=0.0, pm_dec=0.0)
    cls = classify_track(tr, crossmatch={"name": "Barnard's Star", "catalog": "SIMBAD"})
    assert cls["classification"] == "known"
