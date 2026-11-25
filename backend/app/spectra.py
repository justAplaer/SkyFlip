"""On-the-fly spectrum extraction across SPHEREx detectors."""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

from .adapters.spherex import SpherexAdapter, BANDPASSES


def extract_spectrum_at(
    adapter: SpherexAdapter,
    ra: float,
    dec: float,
    *,
    fov_deg: float = 0.03,
    aperture_pix: float = 1.5,
) -> dict[str, Any]:
    """
    For each detector, take the latest (or first available) cutout covering the
    position and measure mean surface brightness in a small aperture, with
    uncertainty from VARIANCE when present.
    """
    points: list[dict[str, Any]] = []
    notes: list[str] = []

    for band in BANDPASSES:
        obs_list = adapter.find_observations(ra, dec, fov_deg=fov_deg, bandpasses=(band,), max_rows=20)
        if not obs_list:
            notes.append(f"{band}: no coverage")
            continue
        # Prefer a mid-list visit for diversity; use first for speed/stability
        o = obs_list[len(obs_list) // 2]
        try:
            cut = adapter.fetch_cutout(o)
            cut = adapter.parse_cutout_fits(cut.fits_path, o, target_ra=ra, target_dec=dec)
        except Exception as exc:
            notes.append(f"{band}: cutout failed ({exc})")
            continue

        yy, xx = np.indices(cut.image.shape)
        try:
            from astropy.coordinates import SkyCoord
            import astropy.units as u

            x0, y0 = cut.wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
        except Exception:
            y0, x0 = (np.array(cut.image.shape) - 1) / 2.0

        rr = np.hypot(xx - x0, yy - y0)
        mask = rr <= aperture_pix
        vals = cut.image[mask]
        vals = vals[np.isfinite(vals)]
        if vals.size == 0:
            notes.append(f"{band}: no finite pixels in aperture")
            continue
        flux = float(np.mean(vals))
        flux_err: Optional[float] = None
        if cut.variance is not None:
            var = cut.variance[mask]
            var = var[np.isfinite(var)]
            if var.size:
                flux_err = float(np.sqrt(np.mean(var) / var.size))
        points.append(
            {
                "wavelength_um": cut.central_wavelength_um,
                "flux": flux,
                "flux_err": flux_err,
                "detector": o.detector,
                "bandpass": band,
                "mjd": o.mjd,
                "obs_id": o.obs_id,
            }
        )

    points = [p for p in points if p.get("wavelength_um") is not None]
    points.sort(key=lambda p: p["wavelength_um"] or 0)
    return {
        "ra": ra,
        "dec": dec,
        "points": points,
        "unit": "MJy/sr (mean aperture surface brightness)",
        "method_note": (
            "One cutout per detector; mean IMAGE value in a "
            f"{aperture_pix}-pixel radius aperture. Flux error from VARIANCE when available; "
            "otherwise no uncertainty available. Wavelength from WCS-WAVE at the target pixel. "
            "Not a calibrated point-source spectrum."
        ),
        "notes": notes,
        "is_synthetic": False,
        "source": "live",
    }
