"""Source detection, linking, and linear-motion fit."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from photutils.detection import DAOStarFinder
from astropy.stats import sigma_clipped_stats


@dataclass
class Detection:
    epoch_id: str
    mjd: float
    x: float
    y: float
    ra: float
    dec: float
    flux: float
    x_err: float = 0.5
    y_err: float = 0.5


@dataclass
class Track:
    id: str
    detections: list[Detection] = field(default_factory=list)
    pm_ra_arcsec_yr: Optional[float] = None
    pm_dec_arcsec_yr: Optional[float] = None
    pm_ra_err: Optional[float] = None
    pm_dec_err: Optional[float] = None
    is_synthetic: bool = False


def detect_sources(
    image: np.ndarray,
    wcs,
    epoch_id: str,
    mjd: float,
    *,
    fwhm: float = 2.5,
    threshold_sigma: float = 4.0,
) -> list[Detection]:
    data = np.asarray(image, dtype=float)
    _, median, std = sigma_clipped_stats(data, sigma=3.0)
    finder = DAOStarFinder(fwhm=fwhm, threshold=threshold_sigma * std)
    tbl = finder(data - median)
    if tbl is None or len(tbl) == 0:
        return []
    out: list[Detection] = []
    # photutils <3: xcentroid/ycentroid; photutils 3+: x_centroid/y_centroid
    colnames = set(tbl.colnames)

    def _col(row, *names: str) -> float:
        for n in names:
            if n in colnames:
                return float(row[n])
        raise KeyError(f"None of {names} in DAOStarFinder table columns {sorted(colnames)}")

    for row in tbl:
        x = _col(row, "x_centroid", "xcentroid")
        y = _col(row, "y_centroid", "ycentroid")
        sky = wcs.pixel_to_world(x, y)
        # Rough centroid uncertainty ~ FWHM / (2.35 * SNR); floor at 0.2 pix
        snr = _col(row, "peak") / (std + 1e-9)
        pix_err = max(0.2, fwhm / (2.35 * max(snr, 1.0)))
        out.append(
            Detection(
                epoch_id=epoch_id,
                mjd=mjd,
                x=x,
                y=y,
                ra=float(sky.ra.deg),
                dec=float(sky.dec.deg),
                flux=_col(row, "flux"),
                x_err=pix_err,
                y_err=pix_err,
            )
        )
    return out


def _ang_sep_arcsec(ra1, dec1, ra2, dec2) -> float:
    # Small-angle approx OK for SPHEREx cutouts
    dra = (ra2 - ra1) * np.cos(np.deg2rad(0.5 * (dec1 + dec2))) * 3600.0
    ddec = (dec2 - dec1) * 3600.0
    return float(np.hypot(dra, ddec))


def link_detections(
    per_epoch: list[list[Detection]],
    *,
    max_sep_arcsec: float = 30.0,
    min_epochs: int = 2,
) -> list[Track]:
    """Greedy nearest-neighbor linking under a loose motion prior."""
    if not per_epoch:
        return []
    tracks: list[Track] = []
    tid = 0
    used = [{False} for _ in per_epoch]  # placeholder
    used = [set() for _ in per_epoch]

    for i, dets in enumerate(per_epoch):
        for di, d0 in enumerate(dets):
            if di in used[i]:
                continue
            chain = [d0]
            used[i].add(di)
            last = d0
            for j in range(i + 1, len(per_epoch)):
                best = None
                best_sep = max_sep_arcsec
                for dj, d1 in enumerate(per_epoch[j]):
                    if dj in used[j]:
                        continue
                    sep = _ang_sep_arcsec(last.ra, last.dec, d1.ra, d1.dec)
                    # Allow motion growing with time (~ few arcsec/day max for nearby)
                    dt = abs(d1.mjd - last.mjd)
                    limit = max_sep_arcsec + 20.0 * dt  # generous
                    if sep < best_sep and sep < limit:
                        best_sep = sep
                        best = (dj, d1)
                if best is None:
                    break
                used[j].add(best[0])
                chain.append(best[1])
                last = best[1]
            if len(chain) >= min_epochs:
                tid += 1
                tr = Track(id=f"trk_{tid:03d}", detections=chain)
                fit_linear_motion(tr)
                tracks.append(tr)
    return tracks


def fit_linear_motion(track: Track, pixel_scale_arcsec: float = 6.15) -> Track:
    """Fit RA/Dec vs time; uncertainties from centroid errors (no uncertainty → note)."""
    dets = track.detections
    if len(dets) < 2:
        return track
    t0 = dets[0].mjd
    t = np.array([(d.mjd - t0) / 365.25 for d in dets])  # years
    ra = np.array([d.ra for d in dets])
    dec = np.array([d.dec for d in dets])
    # Convert RA err to degrees roughly
    ra_err = np.array([d.x_err * pixel_scale_arcsec / 3600.0 / max(np.cos(np.deg2rad(d.dec)), 0.2) for d in dets])
    dec_err = np.array([d.y_err * pixel_scale_arcsec / 3600.0 for d in dets])

    def _fit(y, yerr):
        # Inverse-variance weights once: W = diag(1/σ²). Do NOT also scale
        # rows by 1/σ² again (that was double-weighting → 1/σ⁴).
        w2 = 1.0 / np.maximum(yerr, 1e-9) ** 2
        A = np.vstack([np.ones_like(t), t]).T
        try:
            ata = A.T @ (A * w2[:, None])
            aty = A.T @ (y * w2)
            coeff = np.linalg.solve(ata, aty)
            cov = np.linalg.pinv(ata)
            return float(coeff[1]), float(np.sqrt(max(cov[1, 1], 0.0)))
        except Exception:
            return float(np.polyfit(t, y, 1)[0]), None

    pm_ra_deg_yr, pm_ra_err_deg = _fit(ra, ra_err)
    pm_dec_deg_yr, pm_dec_err_deg = _fit(dec, dec_err)
    # Store as arcsec/yr
    cosd = np.cos(np.deg2rad(np.mean(dec)))
    track.pm_ra_arcsec_yr = pm_ra_deg_yr * 3600.0 * cosd
    track.pm_dec_arcsec_yr = pm_dec_deg_yr * 3600.0
    track.pm_ra_err = None if pm_ra_err_deg is None else pm_ra_err_deg * 3600.0 * cosd
    track.pm_dec_err = None if pm_dec_err_deg is None else pm_dec_err_deg * 3600.0
    return track
