"""Bug 5: catalogue cross-match can label tracks known; failures stay honest."""

from __future__ import annotations

from unittest.mock import patch

from app.classify import classify_track
from app.crossmatch import cone_radius_arcsec, crossmatch_track
from app.detect import Detection, Track, fit_linear_motion


def _barnard_like_track() -> Track:
    # Approximate Barnard's Star field center from demo cache
    ra0, dec0 = 269.45207696, 4.69336497
    pm_ra, pm_dec = -0.801551, 10.362394
    dets = []
    for i in range(4):
        mjd = 60914.0 + i * 90.0
        dt = (mjd - 60914.0) / 365.25
        dets.append(
            Detection(
                epoch_id=f"b{i}",
                mjd=mjd,
                x=10 + i,
                y=10,
                ra=ra0 + (pm_ra / 3600.0) * dt,
                dec=dec0 + (pm_dec / 3600.0) * dt,
                flux=20.0,
                x_err=0.3,
                y_err=0.3,
            )
        )
    tr = Track(id="barnard-trk", detections=dets)
    fit_linear_motion(tr)
    return tr


def test_barnard_position_becomes_known_with_mocked_catalog():
    tr = _barnard_like_track()
    mocked = {
        "name": "Barnard's Star",
        "catalog": "SIMBAD",
        "separation_arcsec": 0.4,
        "pm_ra_cosdec_arcsec_yr": -0.801551,
        "pm_dec_arcsec_yr": 10.362394,
        "status": "matched",
        "source": "live",
    }
    with patch("app.crossmatch._simbad_cone", return_value=mocked):
        with patch("app.crossmatch._match_offline", return_value=None):
            xm = crossmatch_track(tr, prefer_cache=False, allow_live=True)
    assert xm["status"] == "matched"
    assert xm["name"] == "Barnard's Star"
    cls = classify_track(tr, crossmatch=xm)
    assert cls["classification"] == "known"
    assert any("Barnard" in r for r in cls["reasons"])


def test_no_catalogue_match_is_candidate():
    # Significant motion, empty sky — no catalogue hit → unverified candidate
    tr = _barnard_like_track()
    for i, d in enumerate(tr.detections):
        d.ra = 10.0 + i * 0.001  # ~3.6"/step over epochs → clear motion
        d.dec = 20.0 + i * 0.002
    fit_linear_motion(tr)
    xm = {
        "status": "no_match",
        "catalog": "SIMBAD",
        "separation_arcsec": None,
        "source": "live",
    }
    cls = classify_track(tr, crossmatch=xm)
    assert cls["classification"] == "candidate", cls
    assert any("no catalogue match" in r or "unverified candidate" in r for r in cls["reasons"])


def test_failed_lookup_not_crossmatched_state():
    tr = _barnard_like_track()
    xm = {
        "status": "unavailable",
        "catalog": "SIMBAD",
        "note": "catalogue lookup unavailable",
        "source": "error",
    }
    cls = classify_track(tr, crossmatch=xm)
    assert cls["classification"] != "known"
    assert any("not cross-matched" in r for r in cls["reasons"])


def test_cached_offline_path_works():
    tr = _barnard_like_track()
    xm = crossmatch_track(tr, prefer_cache=True, allow_live=False)
    # Offline cache should hit Barnard's Star
    assert xm.get("status") == "cached", xm
    assert "Barnard" in (xm.get("name") or "")
    cls = classify_track(tr, crossmatch=xm)
    assert cls["classification"] == "known"
    assert any("cached" in r for r in cls["reasons"])


def test_cone_radius_configurable_and_positive():
    tr = _barnard_like_track()
    r = cone_radius_arcsec(tr)
    assert 6.0 <= r <= 60.0
