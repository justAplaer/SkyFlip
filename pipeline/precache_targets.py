#!/usr/bin/env python3
"""Pre-cache cutouts + manifests for the five official test targets into frontend/public/demo-data/.

Policy (Phase 1):
- SIA/IBE only (adapter skips TAP)
- FOV 0.15–0.2° (default 0.2°), 6–8 frames maximizing MJD span
- Prefer D5/D6 for cold targets; measure peak S/N; keep best available detector
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time
import astropy.units as u
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.adapters import catalogs  # noqa: E402
from app.adapters.spherex import (  # noqa: E402
    FLAG_BITS,
    PIXEL_SCALE_ARCSEC,
    SpherexAdapter,
    SpherexAdapterError,
)
from app.imaging import (  # noqa: E402
    accent_saturation_flags,
    pm_predicted_display_stamp,
    stretch,
)

# Override with SKYFLIP_DEMO_DATA_OUT for safe staging (see pipeline/refresh_data.py).
OUT = Path(
    os.environ.get("SKYFLIP_DEMO_DATA_OUT")
    or (ROOT / "frontend" / "public" / "demo-data")
)
FOV = 0.2  # within 0.15–0.2°; ~117 px at 6.15″
MIN_FRAMES = 6
MAX_FRAMES = 8
TARGETING_MODE = "fixed_sky"

# Preferred detectors first (cold Y/T dwarfs need longer λ).
# WISE 0855: always measure D5, D6, and D1 (comparison) before choosing default.
DETECTOR_CANDIDATES = {
    "wise0855": ["SPHEREx-D5", "SPHEREx-D6", "SPHEREx-D1"],
    "epsilon_indi_b": ["SPHEREx-D5", "SPHEREx-D6", "SPHEREx-D4", "SPHEREx-D1"],
    "barnards_star": ["SPHEREx-D1", "SPHEREx-D2"],
    "rw_aurigae": ["SPHEREx-D1"],
    "r_draconis": ["SPHEREx-D1"],
}

# Targets where we keep measuring after the first detectable detector so the
# visibility report can compare short-λ vs long-λ honestly (Bug 3).
FORCE_ALL_DETECTOR_COMPARISON = {"wise0855"}

ALL_TARGETS = [
    {"id": "wise0855", "name": "WISE 0855", "ra": 133.79512917, "dec": -7.24514722},
    {"id": "barnards_star", "name": "Barnard's Star"},
    {"id": "epsilon_indi_b", "name": "Epsilon Indi B"},
    {"id": "rw_aurigae", "name": "RW Aurigae"},
    {"id": "r_draconis", "name": "R Draconis"},
]


def _selected_targets():
    only = (os.environ.get("SKYFLIP_PRECACHE_ONLY") or "").strip()
    if not only:
        return ALL_TARGETS
    want = {x.strip() for x in only.split(",") if x.strip()}
    return [t for t in ALL_TARGETS if t["id"] in want]


def resolve(t):
    if "ra" in t:
        return t["ra"], t["dec"]
    r = catalogs.resolve_name(t["name"])
    return r["ra"], r["dec"]


def save_png(
    arr,
    path: Path,
    *,
    flags=None,
    pred_xy: tuple[float, float] | None = None,
    display_assist: bool = False,
):
    """Write blink PNG. Optional saturation accent + PM stamp (display only)."""
    disp = np.asarray(arr, dtype=float).copy()
    if display_assist and pred_xy is not None:
        # Barnard's IMAGE core is blanked; a saturated field star ~165″ away would
        # own the asinh stretch. Flatten distant pixels for display only so the
        # labeled PM stamp (and nearby FLAGS) are visible on the blink.
        yy, xx = np.mgrid[0 : disp.shape[0], 0 : disp.shape[1]]
        # Keep only a tight window around the PM prediction — RefCat residuals
        # near the Gaia epoch (~16 px south) and field stars must not own the stretch.
        near = np.hypot(xx - float(pred_xy[0]), yy - float(pred_xy[1])) <= 10.0
        finite_near = disp[near & np.isfinite(disp)]
        fill = float(np.nanmedian(finite_near)) if finite_near.size else 0.0
        disp[~near] = fill
        if flags is not None:
            disp = accent_saturation_flags(disp, flags, near_xy=pred_xy, near_radius_pix=8.0)
        peak_near = (
            float(np.nanmax(disp[near & np.isfinite(disp)])) if np.any(near) else abs(fill)
        )
        disp = pm_predicted_display_stamp(
            disp,
            pred_xy[0],
            pred_xy[1],
            amplitude=max(peak_near * 5.0, abs(fill) * 50.0, 10.0),
        )
        # hi=100 → vmax=max; otherwise a tiny stamp is absorbed into the 99th
        # percentile and the whole window stretches to white.
        scaled = stretch(disp, "asinh", lo=1.0, hi=100.0)
    elif flags is not None:
        disp = accent_saturation_flags(disp, flags, near_xy=pred_xy)
        scaled = stretch(disp, "asinh")
    else:
        scaled = stretch(disp, "asinh")
    img = Image.fromarray((scaled * 255).astype(np.uint8), mode="L")
    img.save(path)


def pick_max_span(obs_list, n: int = MAX_FRAMES):
    """One obs per calendar day, then pick up to n spanning first→last MJD."""
    by_day = {}
    for o in sorted(obs_list, key=lambda x: x.mjd):
        by_day.setdefault(int(o.mjd), o)
    days = sorted(by_day.keys())
    if not days:
        return []
    if len(days) <= n:
        return [by_day[d] for d in days]
    idxs = np.linspace(0, len(days) - 1, n).round().astype(int)
    idxs = sorted(set(int(i) for i in idxs))
    return [by_day[days[i]] for i in idxs]


def measure_peak_sn(cut, ra: float, dec: float, aper_r_pix: float = 1.5) -> dict:
    """Aperture peak vs local annulus; honest S/N for detector visibility notes.

    When the IMAGE core is saturation-blanked but FLAGS still mark HALO/SOURCE near
    the predicted pixel, set ``saturated_flag_detectable`` so demos can use a
    labeled PM display stamp (float bins stay untouched archive flux).
    """
    img = np.asarray(cut.image, dtype=float)
    flags = np.asarray(cut.flags)
    ny, nx = img.shape
    try:
        x, y = cut.wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg, frame="icrs"))
        x, y = float(x), float(y)
    except Exception:
        x, y = (nx - 1) / 2.0, (ny - 1) / 2.0

    yy, xx = np.mgrid[0:ny, 0:nx]
    rr = np.hypot(xx - x, yy - y)
    aper = rr <= aper_r_pix
    ann = (rr > aper_r_pix * 2.5) & (rr <= aper_r_pix * 5.0)
    fl = flags.astype(np.int64)
    # Exclude heavily flagged pixels when possible
    good = (fl & ((1 << 1) | (1 << 9) | (1 << 6))) == 0  # OVERFLOW, MISSING, NONFUNC
    aper_g = aper & good
    ann_g = ann & good
    if not np.any(aper_g):
        aper_g = aper
    if not np.any(ann_g):
        ann_g = ann
    if not np.any(aper_g) or not np.any(ann_g):
        return {
            "peak_sn": None,
            "x_pix": x,
            "y_pix": y,
            "note": "could not form aperture/annulus",
            "saturated_flag_detectable": False,
        }
    bg = float(np.nanmedian(img[ann_g]))
    bg_std = float(np.nanstd(img[ann_g]))
    peak = float(np.nanmax(img[aper_g]) - bg)
    sn = peak / bg_std if bg_std > 0 else None

    # FLAGS footprint near prediction (Table 16 HALO/SOURCE/BLOOM).
    near = rr <= 8.0
    n_halo = int(np.count_nonzero(near & ((fl & (1 << FLAG_BITS["HALO"])) != 0)))
    n_source = int(np.count_nonzero(near & ((fl & (1 << FLAG_BITS["SOURCE"])) != 0)))
    n_bloom = int(np.count_nonzero(near & ((fl & (1 << FLAG_BITS["BLOOM"])) != 0)))
    core_blank = sn is None or (isinstance(sn, float) and sn < 3.0)
    saturated_flag = bool(core_blank and (n_halo >= 5 or (n_source >= 20 and n_bloom >= 1)))

    return {
        "peak_sn": sn,
        "peak_minus_bg": peak,
        "bg": bg,
        "bg_std": bg_std,
        "x_pix": x,
        "y_pix": y,
        "n_aper": int(np.count_nonzero(aper_g)),
        "n_ann": int(np.count_nonzero(ann_g)),
        "n_halo_near": n_halo,
        "n_source_near": n_source,
        "n_bloom_near": n_bloom,
        "saturated_flag_detectable": saturated_flag,
    }


def try_band(
    adapter: SpherexAdapter,
    *,
    tid: str,
    name: str,
    ra: float,
    dec: float,
    band: str,
    pm: dict,
) -> dict | None:
    """Discover + download frames for one bandpass; return package or None."""
    try:
        obs = adapter.find_observations(
            ra, dec, fov_deg=FOV, bandpasses=(band,), prefer="sia"
        )
    except SpherexAdapterError as exc:
        print(f"  {band}: SIA empty/fail — {exc}")
        return None
    except Exception as exc:
        print(f"  {band}: discovery error — {exc}")
        return None

    # Oversample so truncated edge cutouts can be dropped and still leave 6–8.
    chosen = pick_max_span(obs, max(MAX_FRAMES + 4, 12))
    if len(chosen) < 2:
        print(f"  {band}: only {len(chosen)} distinct-day visits — skip")
        return None

    print(
        f"  {band}: {len(obs)} hits → {len(chosen)} candidate days; "
        f"MJD {chosen[0].mjd:.3f}→{chosen[-1].mjd:.3f} "
        f"(span {(chosen[-1].mjd - chosen[0].mjd) / 365.25:.2f} yr)"
    )

    dest = OUT / tid
    dest.mkdir(parents=True, exist_ok=True)
    # Write each bandpass attempt into its own staging dir so a later detector
    # try cannot delete the winning frames before we promote them.
    band_slug = band.replace("SPHEREx-", "").lower()
    stage = dest / f".stage_{band_slug}"
    if stage.exists():
        for old in stage.iterdir():
            old.unlink()
    else:
        stage.mkdir(parents=True, exist_ok=True)

    # Fixed-sky CRVAL: PM-propagate catalog coords to mid-span SPHEREx epoch.
    # Centering on Gaia/WISE catalog epoch put Barnard's ~100″ off-center.
    mjd_ref = 0.5 * (float(chosen[0].mjd) + float(chosen[-1].mjd))
    cra_fixed, cdec_fixed, center_note = catalogs.fixed_sky_cutout_center(
        ra, dec, pm, mjd_ref
    )
    print(f"  {band}: {center_note} → CRVAL {cra_fixed:.6f}, {cdec_fixed:.6f}")

    frames = []
    pixel_shifts = []
    sn_list = []
    for i, o in enumerate(chosen):
        cra, cdec = cra_fixed, cdec_fixed
        pra, pdec = catalogs.propagate_position(ra, dec, pm, Time(o.mjd, format="mjd"))
        if i == 0:
            pra0, pdec0 = pra, pdec
        dra = (pra - pra0) * np.cos(np.deg2rad(dec)) * 3600.0
        ddec = (pdec - pdec0) * 3600.0
        shift_pix = float(np.hypot(dra, ddec) / PIXEL_SCALE_ARCSEC)
        pixel_shifts.append(shift_pix)

        try:
            cut = adapter.fetch_cutout(
                o,
                subtract_zodi=False,
                center_ra=cra,
                center_dec=cdec,
                size_deg=FOV,
            )
        except Exception as exc:
            print(f"  cutout fail {o.obs_id}: {exc}")
            continue

        # Drop severely truncated edge cutouts (unusable for blink).
        if min(cut.image.shape) < 80:
            print(f"  skip truncated {o.obs_id} shape {cut.image.shape}")
            continue

        sn = measure_peak_sn(cut, pra, pdec)
        sn_val = sn.get("peak_sn")
        if sn_val is not None and not np.isfinite(sn_val):
            sn_val = None
        sn_list.append(sn_val)
        sat_flag = bool(sn.get("saturated_flag_detectable"))
        # Display assist: IMAGE core blanked but FLAGS mark the star near prediction.
        display_assist = sat_flag or (
            sn_val is not None and sn_val < 3.0 and int(sn.get("n_halo_near") or 0) >= 5
        )
        png_name = f"frame_{i:02d}_{o.mjd:.5f}.png"
        save_png(
            cut.image,
            stage / png_name,
            flags=cut.flags,
            pred_xy=(float(sn["x_pix"]), float(sn["y_pix"])),
            display_assist=display_assist,
        )
        # Native float + flags for Change Slider / offline float path (no stamp).
        bin_name = f"frame_{i:02d}_{o.mjd:.5f}_image.bin"
        flags_name = f"frame_{i:02d}_{o.mjd:.5f}_flags.bin"
        np.asarray(cut.image, dtype=np.float32).tofile(stage / bin_name)
        np.asarray(cut.flags).astype(np.int16).tofile(stage / flags_name)

        frames.append(
            {
                "epoch_id": f"{o.obs_id}|{o.bandpass}|{o.mjd}",
                "obs_id": o.obs_id,
                "mjd": o.mjd,
                "time_iso": o.time_iso,
                "bandpass": o.bandpass,
                "detector": o.detector,
                "collection": o.collection,
                "png": png_name,
                "float_bin": bin_name,
                "flags_bin": flags_name,
                "float_shape": list(cut.image.shape),
                "central_wavelength_um": cut.central_wavelength_um,
                "flag_summary": cut.flag_summary,
                "image_shape": list(cut.image.shape),
                "cutout_center_ra": cra,
                "cutout_center_dec": cdec,
                "predicted_ra": pra,
                "predicted_dec": pdec,
                "predicted_x_pix": sn.get("x_pix"),
                "predicted_y_pix": sn.get("y_pix"),
                "predicted_shift_pix_from_epoch0": shift_pix,
                "peak_sn_at_predicted": sn_val,
                "saturated_flag_detectable": sat_flag,
                "n_halo_near": sn.get("n_halo_near"),
                "png_display_assist": display_assist,
                "png_display_note": (
                    "PNG includes PM-predicted stamp + FLAGS accent; "
                    "float .bin is unaltered archive IMAGE (core may be saturation-blanked)"
                    if display_assist
                    else None
                ),
                "cutout_url": o.cutout_url,
                "source_label": "cached demo data",
            }
        )
        print(
            f"    wrote {png_name} shape {cut.image.shape} "
            f"λ={cut.central_wavelength_um} S/N≈{sn_val} "
            f"sat_flag={sat_flag} assist={display_assist}"
        )

    if len(frames) < 2:
        return None

    if len(frames) < MIN_FRAMES:
        print(f"  {band}: only {len(frames)} usable frames after truncation filter")
        return None

    # Keep ≤MAX_FRAMES spanning first→last of the surviving set.
    if len(frames) > MAX_FRAMES:
        idxs = np.linspace(0, len(frames) - 1, MAX_FRAMES).round().astype(int)
        idxs = sorted(set(int(i) for i in idxs))
        frames = [frames[i] for i in idxs]
        sn_list = [sn_list[i] for i in idxs]
        # Re-index predicted shifts relative to new epoch 0
        pra0 = frames[0]["predicted_ra"]
        pdec0 = frames[0]["predicted_dec"]
        for fr in frames:
            dra = (fr["predicted_ra"] - pra0) * np.cos(np.deg2rad(dec)) * 3600.0
            ddec = (fr["predicted_dec"] - pdec0) * 3600.0
            fr["predicted_shift_pix_from_epoch0"] = float(
                np.hypot(dra, ddec) / PIXEL_SCALE_ARCSEC
            )

    sns = [s for s in sn_list if s is not None and np.isfinite(s)]
    median_sn = float(np.median(sns)) if sns else None
    total_shift = pixel_shifts[len(frames) - 1] if pixel_shifts else 0.0
    # Recompute shift from kept frames only
    if len(frames) >= 2:
        total_shift = float(frames[-1].get("predicted_shift_pix_from_epoch0") or 0.0)
    n_sat = sum(1 for f in frames if f.get("saturated_flag_detectable"))
    photometric = median_sn is not None and median_sn >= 3.0
    saturated_ok = n_sat >= max(3, len(frames) // 2)
    detectable = photometric or saturated_ok

    # Measured peak S/N + PM-propagated displacement first→last (fixed cutout grid).
    measured_disp = None
    if len(frames) >= 2:
        measured_disp = {
            "predicted_shift_pix_first_to_last": total_shift,
            "predicted_shift_arcsec_first_to_last": total_shift * PIXEL_SCALE_ARCSEC,
            "median_peak_sn": median_sn,
            "per_frame_peak_sn": sn_list,
            "n_saturated_flag_frames": n_sat,
            "note": (
                "Displacement is PM-propagated sky motion on the fixed cutout grid "
                "(center = catalog applied to mid-span SPHEREx MJD). "
                "Peak S/N is measured in a 1.5 px aperture at the predicted pixel. "
                "If IMAGE is saturation-blanked, FLAGS HALO/SOURCE near prediction "
                "can mark saturated_flag_detectable (PNG may include a labeled PM stamp)."
            ),
        }

    if photometric:
        visibility_note = (
            f"Median peak S/N≈{median_sn:.1f} at PM-predicted pixel on {band}; "
            f"predicted hop {total_shift:.1f} px over cached span."
        )
    elif saturated_ok:
        visibility_note = (
            f"IMAGE aperture S/N≈{median_sn if median_sn is not None else 'n/a'} "
            f"(core saturation-blanked) but FLAGS mark the source near the PM "
            f"prediction on {n_sat}/{len(frames)} frames of {band}; "
            f"PNG uses a labeled PM-predicted display stamp. "
            f"Predicted hop {total_shift:.1f} px. Float .bin remains archive IMAGE."
        )
    else:
        visibility_note = (
            f"not detectable in cached cutouts on {band} "
            f"(median peak S/N≈{median_sn if median_sn is not None else 'n/a'}; "
            f"threshold S/N≥3; saturated FLAGS on {n_sat}/{len(frames)} frames). "
            f"Predicted geometric shift {total_shift:.1f} px only."
        )

    return {
        "frames": frames,
        "band": band,
        "stage_dir": stage,
        "median_sn": median_sn,
        "detectable": detectable,
        "total_shift_pix": total_shift,
        "visibility_note": visibility_note,
        "mjd_span": [frames[0]["mjd"], frames[-1]["mjd"]],
        "pixel_shifts": pixel_shifts,
        "measurement": measured_disp,
        "catalog_ra": ra,
        "catalog_dec": dec,
        "cutout_center_ra": cra_fixed,
        "cutout_center_dec": cdec_fixed,
        "cutout_center_mjd": mjd_ref,
        "cutout_center_note": center_note,
    }


def _promote_stage(dest: Path, stage: Path) -> None:
    """Replace root frame_* files with the winning staged bandpass."""
    for old in list(dest.glob("frame_*.png")) + list(dest.glob("frame_*.bin")):
        old.unlink()
    for f in stage.iterdir():
        target = dest / f.name
        if target.exists():
            target.unlink()
        f.replace(target)
    stage.rmdir()


def _json_dump(path: Path, obj) -> None:
    """JSON with finite floats only (no NaN/Infinity)."""

    def scrub(o):
        if isinstance(o, dict):
            return {k: scrub(v) for k, v in o.items()}
        if isinstance(o, list):
            return [scrub(v) for v in o]
        if isinstance(o, float) and not np.isfinite(o):
            return None
        return o

    path.write_text(json.dumps(scrub(obj), indent=2, default=str) + "\n")


def main() -> int:
    adapter = SpherexAdapter(cache_dir=ROOT / "backend" / ".cache", include_deep=True)
    OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    visibility_report = []
    sia_failures = []

    for t in _selected_targets():
        print("===", t["name"])
        try:
            ra, dec = resolve(t)
        except Exception as exc:
            print("  resolve failed:", exc)
            sia_failures.append({"target": t["id"], "error": f"resolve: {exc}"})
            continue

        pm = catalogs.get_proper_motion(t["name"], ra, dec)
        print("  PM:", pm["citation"], pm["pm_ra_cosdec_arcsec_yr"], pm["pm_dec_arcsec_yr"])

        bands = DETECTOR_CANDIDATES.get(t["id"], ["SPHEREx-D1"])
        best = None
        attempts = []
        for band in bands:
            pkg = try_band(
                adapter, tid=t["id"], name=t["name"], ra=ra, dec=dec, band=band, pm=pm
            )
            attempts.append(
                {
                    "bandpass": band,
                    "ok": pkg is not None,
                    "median_sn": None if pkg is None else pkg["median_sn"],
                    "detectable": None if pkg is None else pkg["detectable"],
                    "n_frames": 0 if pkg is None else len(pkg["frames"]),
                    "mjd_span": None if pkg is None else pkg["mjd_span"],
                    "predicted_shift_pix_first_to_last": (
                        None if pkg is None else pkg["total_shift_pix"]
                    ),
                    "measurement": None if pkg is None else pkg.get("measurement"),
                }
            )
            if pkg is None:
                continue
            # Prefer detectable long-λ packages. For WISE 0855, D1 aperture S/N can
            # be dominated by confusion/background (cold Y dwarf SED peaks ~4–5 µm),
            # so never promote D1 over a detectable D5/D6 package.
            preferred_set = {bands[0]}
            if t["id"] == "wise0855":
                preferred_set = {"SPHEREx-D5", "SPHEREx-D6"}

            def _rank(p: dict) -> tuple:
                on_pref = 1 if p["band"] in preferred_set else 0
                det = 1 if p["detectable"] else 0
                sn = p["median_sn"] if p["median_sn"] is not None else -1.0
                return (on_pref, det, sn)

            if best is None or _rank(pkg) > _rank(best):
                best = pkg
            # Bug 3: for WISE 0855 keep measuring D5/D6/D1 for the visibility report.
            if pkg["detectable"] and t["id"] not in FORCE_ALL_DETECTOR_COMPARISON:
                break

        if best is None:
            print("  FAIL: no usable cutouts for any candidate detector")
            sia_failures.append({"target": t["id"], "error": "all detectors empty", "attempts": attempts})
            continue

        dest = OUT / t["id"]
        _promote_stage(dest, best["stage_dir"])
        # Drop losing stage dirs
        for leftover in dest.glob(".stage_*"):
            for f in leftover.iterdir():
                f.unlink()
            leftover.rmdir()

        # If preferred long-λ detectors empty/undetectable, document honesty
        preferred = bands[0]
        if best["band"] != preferred and not best["detectable"]:
            note_extra = (
                f" Preferred {preferred} empty or below S/N; "
                f"offline demo keeps best available {best['band']}."
            )
        elif best["band"] != preferred:
            note_extra = f" Using {best['band']} (preferred {preferred} not selected)."
        else:
            note_extra = ""

        vis = {
            "target_id": t["id"],
            "name": t["name"],
            "bandpass_cached": best["band"],
            "fov_deg": FOV,
            "n_frames": len(best["frames"]),
            "mjd_span": best["mjd_span"],
            "pm_citation": pm["citation"],
            "pm_ra_cosdec_arcsec_yr": pm["pm_ra_cosdec_arcsec_yr"],
            "pm_dec_arcsec_yr": pm["pm_dec_arcsec_yr"],
            "pm_uncertainty": pm["uncertainty_note"],
            "predicted_shift_pix_first_to_last": best["total_shift_pix"],
            "predicted_shift_arcsec_first_to_last": best["total_shift_pix"] * PIXEL_SCALE_ARCSEC,
            "median_peak_sn": best["median_sn"],
            "detectable_in_cached_cutouts": best["detectable"],
            "visibility": best["visibility_note"] + note_extra,
            "detector_attempts": attempts,
            "image_shape": best["frames"][0]["image_shape"],
            "targeting_mode": TARGETING_MODE,
            "irsa_mode": "sia+ibe",
        }
        visibility_report.append(vis)

        # Top-level ra/dec = fixed cutout CRVAL (SPHEREx-era for high-PM).
        # catalog_* keep the PM reference-epoch coordinates for overlays.
        cut_ra = best.get("cutout_center_ra", ra)
        cut_dec = best.get("cutout_center_dec", dec)
        man = {
            "target_id": t["id"],
            "name": t["name"],
            "ra": cut_ra,
            "dec": cut_dec,
            "catalog_ra": best.get("catalog_ra", ra),
            "catalog_dec": best.get("catalog_dec", dec),
            "cutout_center_mjd": best.get("cutout_center_mjd"),
            "cutout_center_note": best.get("cutout_center_note"),
            "fov_deg": FOV,
            "bandpass": best["band"],
            "targeting_mode": TARGETING_MODE,
            "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
            "proper_motion": {
                "pm_ra_cosdec_arcsec_yr": pm["pm_ra_cosdec_arcsec_yr"],
                "pm_dec_arcsec_yr": pm["pm_dec_arcsec_yr"],
                "citation": pm["citation"],
                "uncertainty_note": pm["uncertainty_note"],
                "ref_epoch": float(pm["ref_epoch"].decimalyear)
                if hasattr(pm.get("ref_epoch"), "decimalyear")
                else pm.get("ref_epoch"),
            },
            "frames": best["frames"],
            "source": "cached-demo",
            "source_label": "cached demo data",
            "is_synthetic": False,
            "credit": "NASA/JPL-Caltech/IPAC — SPHEREx at IRSA",
            "visibility": vis,
        }
        _json_dump(OUT / t["id"] / "manifest.json", man)
        summary.append(
            {
                "id": t["id"],
                "name": t["name"],
                "n_frames": len(best["frames"]),
                "ra": cut_ra,
                "dec": cut_dec,
                "catalog_ra": best.get("catalog_ra", ra),
                "catalog_dec": best.get("catalog_dec", dec),
                "fov_deg": FOV,
                "bandpass": best["band"],
                "median_peak_sn": best["median_sn"],
                "detectable": best["detectable"],
                "predicted_shift_pix": best["total_shift_pix"],
            }
        )

    # Partial runs (SKYFLIP_PRECACHE_ONLY) merge into existing index/visibility/pm.
    def _merge_by_id(existing_list, new_list, id_key="id"):
        by = {}
        for row in existing_list or []:
            key = row.get(id_key) or row.get("target_id")
            if key:
                by[key] = row
        for row in new_list:
            key = row.get(id_key) or row.get("target_id")
            if key:
                by[key] = row
        order = [t["id"] for t in ALL_TARGETS]
        return [by[i] for i in order if i in by] + [by[k] for k in by if k not in order]

    prev_index = []
    prev_vis = []
    try:
        prev_index = json.loads((OUT / "index.json").read_text()).get("targets") or []
    except Exception:
        pass
    try:
        prev_vis = json.loads((OUT / "visibility_report.json").read_text())
        if not isinstance(prev_vis, list):
            prev_vis = []
    except Exception:
        pass

    summary = _merge_by_id(prev_index, summary, "id")
    visibility_report = _merge_by_id(prev_vis, visibility_report, "target_id")

    _json_dump(OUT / "index.json", {"targets": summary})
    _json_dump(OUT / "visibility_report.json", visibility_report)
    # pm_table.json is curated SSOT (historical_markers / missing_markers / notes).
    # Do not write it here — refresh_data copies the live demo SSOT into staging.

    # Rank visible movers for demo default recommendation (data-confirmed).
    movers = sorted(
        [s for s in summary if s.get("detectable") and (s.get("predicted_shift_pix") or 0) >= 1.0],
        key=lambda s: (s.get("predicted_shift_pix") or 0) * (s.get("median_peak_sn") or 0),
        reverse=True,
    )
    # High-PM but below S/N gate still listed for honesty (e.g. Barnard's if aperture S/N fails).
    high_pm = sorted(
        [s for s in summary if (s.get("predicted_shift_pix") or 0) >= 1.0],
        key=lambda s: s.get("predicted_shift_pix") or 0,
        reverse=True,
    )
    rec = {
        "recommended_demo_default": movers[0]["id"] if movers else (
            high_pm[0]["id"] if high_pm else (summary[0]["id"] if summary else None)
        ),
        "ranking_detectable_movers": movers,
        "ranking_by_predicted_shift": high_pm,
        "note": (
            "Default = strongest detectable mover (S/N≥3 and predicted hop ≥1 px) "
            "confirmed from this precache. If WISE 0855 wins on D5, it is the default; "
            "otherwise it stays a button with an honest visibility note."
        ),
    }
    _json_dump(OUT / "demo_recommendation.json", rec)
    if sia_failures:
        _json_dump(OUT / "precache_failures.json", sia_failures)

    print("Done summary:", summary)
    print("Demo recommendation:", rec.get("recommended_demo_default"))
    if sia_failures:
        print("PARTIAL FAILURES:", sia_failures)
        if not summary:
            print("FATAL: SIA failed for all targets — stop and tell the operator.")
            return 2
    return 0 if summary else 1


if __name__ == "__main__":
    raise SystemExit(main())
