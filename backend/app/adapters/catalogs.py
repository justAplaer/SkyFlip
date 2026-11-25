"""Catalog adapters (SIMBAD/Sesame, Gaia, JPL). Phase 0: name resolve + pings."""

from __future__ import annotations

from typing import Any, Optional  # Any used by _coerce_ref_epoch / PM dicts

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.coordinates.name_resolve import NameResolveError
from astropy.time import Time


class CatalogAdapterError(RuntimeError):
    pass


# Verified literature fallback for WISE 0855 when SIMBAD PM query fails.
# Luhman 2014, ApJ 786 L18 / arXiv:1404.6501 Table 1:
#   μα cos δ = −8.06 ± 0.09 ″/yr, μδ = +0.70 ± 0.07 ″/yr
# Challenge coordinates (08h55m10.831s, −7d14m42.53s) match the WISE designation
# epoch (~2010); SPHEREx visits are ~2025 so ~15 yr of motion ≈ 120″ ≈ 20 SPHEREx pixels.
WISE0855_LUHMAN2014 = {
    "pm_ra_cosdec_arcsec_yr": -8.06,
    "pm_dec_arcsec_yr": 0.70,
    "pm_ra_err": 0.09,
    "pm_dec_err": 0.07,
    "ref_epoch": Time(2010.5, format="decimalyear"),
    "citation": "Luhman 2014, ApJ 786 L18 (arXiv:1404.6501) Table 1",
}

# Gaia DR3 4472832130942575872 — values widely published (ESA Gaia / Wikipedia Gaia DR3 table).
# Formal σ not inlined here: see Gaia Archive for the source; UI notes "see Gaia Archive".
BARNARDS_GAIA_DR3 = {
    "pm_ra_cosdec_arcsec_yr": -0.801551,  # −801.551 mas/yr
    "pm_dec_arcsec_yr": 10.362394,  # +10362.394 mas/yr
    "pm_ra_err": None,
    "pm_dec_err": None,
    "ref_epoch": Time(2016.0, format="decimalyear"),
    "citation": (
        "Gaia DR3 source 4472832130942575872 "
        "(pmra=−801.551 mas/yr, pmdec=+10362.394 mas/yr; epoch J2016.0)"
    ),
}

# ε Indi Ba/Bb share the system space motion of ε Indi A (SIMBAD / Hipparcos–Gaia).
# Used only when live SIMBAD PM for "Epsilon Indi B" is unavailable.
EPSILON_INDI_B_SYSTEM = {
    "pm_ra_cosdec_arcsec_yr": 3.96141,  # +3961.41 mas/yr
    "pm_dec_arcsec_yr": -2.53608,  # −2536.08 mas/yr
    "pm_ra_err": None,
    "pm_dec_err": None,
    "ref_epoch": Time(2016.0, format="decimalyear"),
    "citation": (
        "ε Indi system PM (SIMBAD ε Indi A / Gaia DR3 family; "
        "pmra≈+3961.41 mas/yr, pmdec≈−2536.08 mas/yr; epoch J2016.0) — "
        "applied to companion B when object-specific PM is unavailable"
    ),
}


def resolve_name(name: str) -> dict[str, Any]:
    """
    Resolve an object name to ICRS RA/Dec.

    Uses Astropy ``SkyCoord.from_name`` (CDS Sesame → SIMBAD/NED/VizieR).
    Preferred over raw astroquery.Simbad TAP here because the SIMBAD
    capabilities endpoint currently 404s for some astroquery versions.
    """
    try:
        coord = SkyCoord.from_name(name)
    except NameResolveError as exc:
        raise CatalogAdapterError(f"No match for {name!r}: {exc}") from exc
    except Exception as exc:
        raise CatalogAdapterError(f"Name resolve failed for {name!r}: {exc}") from exc

    return {
        "name": name,
        "ra": float(coord.ra.deg),
        "dec": float(coord.dec.deg),
        "catalog": "Sesame/SIMBAD",
        "source": "live",
        "uncertainty_arcsec": None,
        "uncertainty_note": "Sesame/SIMBAD coordinates; no separate uncertainty provided by resolver",
    }


def get_proper_motion(name: str, ra: float, dec: float) -> dict[str, Any]:
    """
    Return pm (arcsec/yr), reference epoch, and citation.

    Order: demo pm_table.json (SSOT for the five targets) → live SIMBAD →
    cited literature fallbacks (WISE 0855 Luhman 2014; Barnard's Gaia DR3;
    ε Indi system PM). Never invent a number.
    """
    from ..pm_table import pm_for_name

    # Demo targets: pm_table.json is the single source of truth.
    cached = pm_for_name(name)
    if cached is not None:
        return cached

    pm_ra = pm_dec = None
    pm_ra_err = pm_dec_err = None
    citation = "none"
    ref_epoch = Time(2000.0, format="decimalyear")
    try:
        from astroquery.simbad import Simbad

        s = Simbad()
        s.add_votable_fields("pmra", "pmdec", "pmra_err", "pmdec_err")
        tab = s.query_object(name)
        if tab is not None and len(tab) > 0:
            row = tab[0]
            for pra, pde, era, ede in (
                ("pmra", "pmdec", "pmra_err", "pmdec_err"),
                ("PMRA", "PMDEC", "PMRA_ERR", "PMDEC_ERR"),
            ):
                if pra in row.colnames and row[pra] is not np.ma.masked:
                    # SIMBAD pmra is usually mas/yr
                    pm_ra = float(row[pra]) / 1000.0
                    pm_dec = float(row[pde]) / 1000.0
                    if era in row.colnames and row[era] is not np.ma.masked:
                        pm_ra_err = float(row[era]) / 1000.0
                        pm_dec_err = float(row[ede]) / 1000.0
                    citation = "SIMBAD proper motion (mas/yr → arcsec/yr)"
                    ref_epoch = Time(2000.0, format="decimalyear")
                    break
    except Exception:
        pass

    # Literature constants (WISE0855_LUHMAN2014, etc.) live only in pm_table.json
    # for the five demo targets — do not apply name-heuristic fallbacks here.
    if pm_ra is None:
        return {
            "ra": ra,
            "dec": dec,
            "pm_ra_cosdec_arcsec_yr": 0.0,
            "pm_dec_arcsec_yr": 0.0,
            "pm_ra_err": None,
            "pm_dec_err": None,
            "ref_epoch": ref_epoch,
            "citation": "no proper motion available",
            "uncertainty_note": "no uncertainty available",
            "source": "none",
            "error": (
                f"No proper motion for {name!r}: not in pm_table.json and SIMBAD "
                "returned none. Ghost track unavailable."
            ),
        }

    return {
        "ra": ra,
        "dec": dec,
        "pm_ra_cosdec_arcsec_yr": float(pm_ra),
        "pm_dec_arcsec_yr": float(pm_dec),
        "pm_ra_err": pm_ra_err,
        "pm_dec_err": pm_dec_err,
        "ref_epoch": ref_epoch,
        "citation": citation,
        "uncertainty_note": (
            f"σ_μα={pm_ra_err}\"/yr, σ_μδ={pm_dec_err}\"/yr"
            if pm_ra_err is not None
            else "no uncertainty available"
        ),
        "source": "live" if citation.startswith("SIMBAD") else "literature_fallback",
    }


def _coerce_ref_epoch(ref: Any) -> Time:
    """Accept Time, decimal-year float/int, or numeric string (e.g. '2016.0')."""
    if isinstance(ref, Time):
        return ref
    if isinstance(ref, (int, float)):
        return Time(float(ref), format="decimalyear")
    if isinstance(ref, str) and ref.strip():
        try:
            return Time(float(ref.strip()), format="decimalyear")
        except Exception:
            pass
    return Time(2000.0, format="decimalyear")


def propagate_position(
    ra: float,
    dec: float,
    pm: dict[str, Any],
    obstime: Time,
) -> tuple[float, float]:
    """Propagate RA/Dec to obstime with SkyCoord.apply_space_motion."""
    ref = _coerce_ref_epoch(pm.get("ref_epoch"))
    coord = SkyCoord(
        ra=ra * u.deg,
        dec=dec * u.deg,
        pm_ra_cosdec=(pm.get("pm_ra_cosdec_arcsec_yr") or 0.0) * u.arcsec / u.yr,
        pm_dec=(pm.get("pm_dec_arcsec_yr") or 0.0) * u.arcsec / u.yr,
        obstime=ref,
    )
    try:
        moved = coord.apply_space_motion(new_obstime=obstime)
    except Exception:
        # Fallback linear approx
        dt = (obstime - ref).to(u.yr).value
        pra = ra + (pm.get("pm_ra_cosdec_arcsec_yr") or 0.0) * dt / 3600.0 / max(
            np.cos(np.deg2rad(dec)), 0.2
        )
        pdec = dec + (pm.get("pm_dec_arcsec_yr") or 0.0) * dt / 3600.0
        return float(pra), float(pdec)
    return float(moved.ra.deg), float(moved.dec.deg)


def significant_proper_motion(pm: dict[str, Any], floor_arcsec_yr: float = 0.05) -> bool:
    """True when |μ| exceeds a small floor (variables with μ≈0 return False)."""
    mu = float(
        np.hypot(
            pm.get("pm_ra_cosdec_arcsec_yr") or 0.0,
            pm.get("pm_dec_arcsec_yr") or 0.0,
        )
    )
    return mu >= floor_arcsec_yr


def fixed_sky_cutout_center(
    catalog_ra: float,
    catalog_dec: float,
    pm: dict[str, Any],
    mjd_ref: float,
) -> tuple[float, float, str]:
    """Fixed-sky blink cutout CRVAL: catalog position propagated to mjd_ref.

    Do **not** center high-PM cutouts on the catalog epoch (e.g. Gaia J2016.0).
    By SPHEREx epoch the object can be tens of arcsec away → edge truncation /
    tiny S/N (Barnard's Star audit: median S/N≈0.67 with 96×117 cutouts).

    All frames share this center so movers still hop on a fixed sky grid.
    """
    if not significant_proper_motion(pm):
        return (
            float(catalog_ra),
            float(catalog_dec),
            "fixed_sky center = catalog coords (no significant PM)",
        )
    cra, cdec = propagate_position(
        catalog_ra, catalog_dec, pm, Time(mjd_ref, format="mjd")
    )
    note = (
        f"fixed_sky center = apply_space_motion(catalog → MJD {mjd_ref:.5f}); "
        f"catalog epoch was {pm.get('ref_epoch')}"
    )
    return float(cra), float(cdec), note


def ping_simbad() -> dict[str, Any]:
    try:
        resolve_name("Sirius")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def ping_jpl() -> dict[str, Any]:
    """Phase 0: connectivity probe only (Horizons)."""
    import requests

    try:
        r = requests.get(
            "https://ssd.jpl.nasa.gov/api/horizons.api",
            params={"format": "json", "COMMAND": "'1'", "OBJ_DATA": "'YES'", "MAKE_EPHEM": "'NO'"},
            timeout=30,
        )
        return {"ok": r.status_code == 200, "status_code": r.status_code}
    except requests.RequestException as exc:
        return {"ok": False, "error": str(exc)}
