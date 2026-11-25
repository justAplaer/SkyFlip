"""PM table SSOT + historical overlay propagation."""

from __future__ import annotations

from astropy.coordinates import SkyCoord
from astropy.time import Time
from astropy.wcs import WCS
import astropy.units as u
import numpy as np

from app.adapters import catalogs
from app.models import DataSource
from app.pm_table import clear_pm_table_cache, find_target_row, pm_for_name
from app.predicted_track import build_predicted_track


def _tan(ra: float, dec: float, shape=(117, 117), scale=6.15):
    w = WCS(naxis=2)
    w.wcs.crpix = [(shape[1] + 1) / 2.0, (shape[0] + 1) / 2.0]
    w.wcs.cdelt = [-scale / 3600.0, scale / 3600.0]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def test_pm_table_barnards_gaia_epoch():
    clear_pm_table_cache()
    row = find_target_row("Barnard's Star")
    assert row is not None
    assert float(row["ref_epoch"]) == 2016.0
    assert any(m["id"] == "gaia_dr3" for m in row["historical_markers"])
    pm = pm_for_name("barnards_star")
    assert pm is not None
    assert abs(pm["pm_dec_arcsec_yr"] - 10.362394) < 1e-6


def test_pm_table_wise0855_luhman_and_challenge_epoch():
    clear_pm_table_cache()
    row = find_target_row("WISE 0855")
    assert row is not None
    assert float(row["ref_epoch"]) == 2010.5
    assert row["historical_markers"][0]["id"] == "wise_designation"
    assert any(m["id"] == "gaia_dr3" for m in row["missing_markers"])
    assert any(m["id"] == "catwise2020" for m in row["missing_markers"])


def test_get_proper_motion_uses_pm_table_ssot():
    clear_pm_table_cache()
    pm = catalogs.get_proper_motion("Barnard's Star", 0.0, 0.0)
    assert pm["source"] == "pm_table"
    assert "Gaia DR3" in pm["citation"]


def test_barnards_historical_arrow_is_many_pixels():
    """Catalog @ J2016 vs first SPHEREx visit (~2025.6) must show a clear arrow."""
    clear_pm_table_cache()
    ra, dec = 269.4520769586187, 4.69336496657667
    frames = [
        {"epoch_id": "e0", "mjd": 60914.21253},
        {"epoch_id": "e1", "mjd": 61285.257036},
    ]
    resp = build_predicted_track(
        name="Barnard's Star",
        cutout_ra=ra,
        cutout_dec=dec,
        frames=frames,
        wcs=_tan(ra, dec, shape=(96, 117)),
        source=DataSource.cached_demo,
    )
    assert len(resp.historical_markers) == 1
    m = resp.historical_markers[0]
    assert m.id == "gaia_dr3"
    assert m.x_pix is not None and m.y_pix is not None
    p0 = resp.points[0]
    assert p0.x_pix is not None and p0.y_pix is not None
    assert p0.offset_from_catalog_arcsec is not None
    # ~9.6 yr × ~10.36"/yr ≈ 100"
    assert 80.0 < p0.offset_from_catalog_arcsec < 120.0
    assert p0.offset_from_catalog_pix is not None
    assert p0.offset_from_catalog_pix > 10.0
    # Arrow length in pixels on the cutout
    dist = float(np.hypot(p0.x_pix - m.x_pix, p0.y_pix - m.y_pix))
    assert dist > 10.0
    # No PM σ in table → honest note
    assert "no uncertainty" in (p0.offset_uncertainty_note or "").lower()


def test_apply_space_motion_matches_linear_approx_order():
    clear_pm_table_cache()
    pm = catalogs.get_proper_motion("WISE 0855", 133.79512917, -7.24514722)
    t1 = Time(60801.1066, format="mjd")
    pra, pdec = catalogs.propagate_position(133.79512917, -7.24514722, pm, t1)
    dt = float(t1.decimalyear) - 2010.5
    # Linear approx for comparison (order-of-magnitude)
    approx_dec = -7.24514722 + 0.7 * dt / 3600.0
    assert abs(pdec - approx_dec) < 0.01  # deg tolerance generous; PM-dominated
    assert abs(pra - 133.79512917) > 0.01  # moved in RA


def test_fixed_sky_center_barnards_not_gaia_epoch():
    """Cutout CRVAL must be SPHEREx-era, not Gaia J2016 (audit: S/N≈0.67)."""
    clear_pm_table_cache()
    pm = catalogs.get_proper_motion("Barnard's Star", 0.0, 0.0)
    cat_ra = float(pm["ra"])
    cat_dec = float(pm["dec"])
    # Mid-span MJD from current demo (~60914…61285)
    mjd_ref = 0.5 * (60914.21253 + 61285.257036)
    cra, cdec, note = catalogs.fixed_sky_cutout_center(cat_ra, cat_dec, pm, mjd_ref)
    assert "apply_space_motion" in note
    # ~9–10 yr × 10.36″/yr ≈ 100″ ≈ 0.028° in Dec
    sep = SkyCoord(cat_ra * u.deg, cat_dec * u.deg).separation(
        SkyCoord(cra * u.deg, cdec * u.deg)
    )
    assert 60.0 < sep.arcsec < 140.0
    assert abs(cdec - cat_dec) > 0.01


def test_fixed_sky_center_variable_stays_catalog():
    clear_pm_table_cache()
    pm = catalogs.get_proper_motion("RW Aurigae", 76.95, 30.40)
    cra, cdec, note = catalogs.fixed_sky_cutout_center(76.95, 30.40, pm, 61000.0)
    assert abs(cra - 76.95) < 1e-9
    assert abs(cdec - 30.40) < 1e-9
    assert "no significant PM" in note
