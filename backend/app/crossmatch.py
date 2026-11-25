"""Cone-search cross-match for mover tracks (SIMBAD + offline demo cache).

Never claims a discovery. Matched → classification "known" with reference.
Lookup failure → crossmatch_status="unavailable" (candidate not cross-matched).
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord

from .adapters.spherex import PIXEL_SCALE_ARCSEC
from .cache import DEMO_DATA
from .detect import Track

logger = logging.getLogger("skyflip.crossmatch")

# Default cone ≈ max(2 SPHEREx pixels, position uncertainty + PM×span).
DEFAULT_BASE_RADIUS_ARCSEC = 2.0 * PIXEL_SCALE_ARCSEC  # 12.3″
DEFAULT_TIMEOUT_S = 20.0
DEFAULT_RETRIES = 2

CROSSMATCH_CACHE_PATH = DEMO_DATA / "crossmatch_cache.json"


def _load_offline_cache() -> list[dict[str, Any]]:
    if not CROSSMATCH_CACHE_PATH.exists():
        return []
    try:
        data = json.loads(CROSSMATCH_CACHE_PATH.read_text(encoding="utf-8"))
        return list(data.get("objects") or [])
    except Exception as exc:
        logger.warning("crossmatch cache unreadable: %s", exc)
        return []


def write_demo_crossmatch_cache(objects: list[dict[str, Any]]) -> Path:
    CROSSMATCH_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "cached",
        "note": (
            "Offline SIMBAD/Gaia-style positions for the five demo targets. "
            "Labeled cached — not a live discovery claim."
        ),
        "objects": objects,
    }
    CROSSMATCH_CACHE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return CROSSMATCH_CACHE_PATH


def cone_radius_arcsec(
    track: Track,
    *,
    base_arcsec: float = DEFAULT_BASE_RADIUS_ARCSEC,
    min_arcsec: float = 6.0,
    max_arcsec: float = 60.0,
) -> float:
    """Radius from position uncertainty and PM over the observation span."""
    dets = track.detections
    if len(dets) < 2:
        return float(np.clip(base_arcsec, min_arcsec, max_arcsec))
    ra_errs = [d.x_err * PIXEL_SCALE_ARCSEC for d in dets]
    dec_errs = [d.y_err * PIXEL_SCALE_ARCSEC for d in dets]
    pos_unc = float(np.nanmedian(np.hypot(ra_errs, dec_errs)))
    mjds = [d.mjd for d in dets]
    span_yr = (max(mjds) - min(mjds)) / 365.25
    pm = float(
        np.hypot(track.pm_ra_arcsec_yr or 0.0, track.pm_dec_arcsec_yr or 0.0)
    )
    radius = max(base_arcsec, pos_unc * 3.0, pm * span_yr + pos_unc)
    return float(np.clip(radius, min_arcsec, max_arcsec))


def _match_offline(
    ra: float,
    dec: float,
    radius_arcsec: float,
) -> Optional[dict[str, Any]]:
    objs = _load_offline_cache()
    if not objs:
        return None
    c0 = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
    best = None
    best_sep = None
    for obj in objs:
        c1 = SkyCoord(ra=float(obj["ra"]) * u.deg, dec=float(obj["dec"]) * u.deg, frame="icrs")
        sep = float(c0.separation(c1).arcsec)
        if sep <= radius_arcsec and (best_sep is None or sep < best_sep):
            best_sep = sep
            best = obj
    if best is None:
        return None
    return {
        "name": best["name"],
        "catalog": best.get("catalog", "cached-demo"),
        "separation_arcsec": best_sep,
        "pm_ra_cosdec_arcsec_yr": best.get("pm_ra_cosdec_arcsec_yr"),
        "pm_dec_arcsec_yr": best.get("pm_dec_arcsec_yr"),
        "status": "cached",
        "source": "cached",
        "note": "cached offline cross-match for demo target",
    }


def _simbad_cone(
    ra: float,
    dec: float,
    radius_arcsec: float,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    retries: int = DEFAULT_RETRIES,
) -> dict[str, Any]:
    """Live SIMBAD cone; returns status matched / no_match / unavailable."""
    last_err = None
    for attempt in range(max(1, retries + 1)):
        try:
            from astroquery.simbad import Simbad

            s = Simbad()
            s.TIMEOUT = timeout_s
            s.add_votable_fields("pmra", "pmdec", "otype")
            coord = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
            tab = s.query_region(coord, radius=radius_arcsec * u.arcsec)
            if tab is None or len(tab) == 0:
                return {
                    "status": "no_match",
                    "catalog": "SIMBAD",
                    "separation_arcsec": None,
                    "radius_arcsec": radius_arcsec,
                    "source": "live",
                }
            # Pick nearest
            if "RA" in tab.colnames and "DEC" in tab.colnames:
                ras = np.asarray(tab["RA"], dtype=float)
                decs = np.asarray(tab["DEC"], dtype=float)
                # SIMBAD may return sexagesimal strings in some versions — fall back
            # Prefer MAIN_ID
            name_col = "MAIN_ID" if "MAIN_ID" in tab.colnames else tab.colnames[0]
            # Compute separations when possible
            best_i = 0
            best_sep = None
            try:
                c0 = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
                for i in range(len(tab)):
                    # Coordinates: try RA/DEC degrees or use SkyCoord.from_name later
                    if "RA_d" in tab.colnames:
                        c1 = SkyCoord(
                            ra=float(tab["RA_d"][i]) * u.deg,
                            dec=float(tab["DEC_d"][i]) * u.deg,
                            frame="icrs",
                        )
                    elif "ra" in [c.lower() for c in tab.colnames]:
                        # modern astroquery uses ra/dec in degrees
                        ra_key = next(c for c in tab.colnames if c.lower() == "ra")
                        dec_key = next(c for c in tab.colnames if c.lower() == "dec")
                        c1 = SkyCoord(
                            ra=float(tab[ra_key][i]) * u.deg,
                            dec=float(tab[dec_key][i]) * u.deg,
                            frame="icrs",
                        )
                    else:
                        break
                    sep = float(c0.separation(c1).arcsec)
                    if best_sep is None or sep < best_sep:
                        best_sep = sep
                        best_i = i
            except Exception:
                best_i = 0
                best_sep = None

            row = tab[best_i]
            name = str(row[name_col]).strip()
            pm_ra = pm_dec = None
            for pra, pde in (("pmra", "pmdec"), ("PMRA", "PMDEC")):
                if pra in row.colnames and row[pra] is not np.ma.masked:
                    pm_ra = float(row[pra]) / 1000.0  # mas/yr → arcsec/yr
                    pm_dec = float(row[pde]) / 1000.0
                    break
            return {
                "name": name,
                "catalog": "SIMBAD",
                "separation_arcsec": best_sep,
                "radius_arcsec": radius_arcsec,
                "pm_ra_cosdec_arcsec_yr": pm_ra,
                "pm_dec_arcsec_yr": pm_dec,
                "status": "matched",
                "source": "live",
            }
        except Exception as exc:
            last_err = exc
            logger.warning("SIMBAD cone attempt %s failed: %s", attempt + 1, exc)
            time.sleep(0.4 * (attempt + 1))
    return {
        "status": "unavailable",
        "catalog": "SIMBAD",
        "radius_arcsec": radius_arcsec,
        "source": "error",
        "error": str(last_err) if last_err else "SIMBAD unavailable",
        "note": "catalogue lookup unavailable — track kept as candidate (not cross-matched)",
    }


def crossmatch_track(
    track: Track,
    *,
    radius_arcsec: Optional[float] = None,
    prefer_cache: bool = True,
    allow_live: bool = True,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    retries: int = DEFAULT_RETRIES,
) -> dict[str, Any]:
    """
    Cross-match a track's mean position against SIMBAD (or offline cache).

    Returns a crossmatch dict always including `status`:
      matched | cached | no_match | unavailable
    """
    dets = track.detections
    if not dets:
        return {"status": "unavailable", "note": "empty track"}
    ra = float(np.mean([d.ra for d in dets]))
    dec = float(np.mean([d.dec for d in dets]))
    radius = float(radius_arcsec) if radius_arcsec is not None else cone_radius_arcsec(track)

    if prefer_cache:
        hit = _match_offline(ra, dec, radius)
        if hit is not None:
            hit["radius_arcsec"] = radius
            hit["track_ra"] = ra
            hit["track_dec"] = dec
            return hit

    if not allow_live:
        return {
            "status": "unavailable",
            "radius_arcsec": radius,
            "track_ra": ra,
            "track_dec": dec,
            "note": "live catalogue disabled; no cached match",
        }

    result = _simbad_cone(ra, dec, radius, timeout_s=timeout_s, retries=retries)
    result["track_ra"] = ra
    result["track_dec"] = dec
    # Offline fallback if live failed
    if result.get("status") == "unavailable":
        hit = _match_offline(ra, dec, radius)
        if hit is not None:
            hit["radius_arcsec"] = radius
            hit["track_ra"] = ra
            hit["track_dec"] = dec
            hit["note"] = "cached offline after live catalogue failure"
            return hit
    return result
