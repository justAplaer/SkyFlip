"""
Per-frame change scores at a sky position (candidates only — not discoveries).

Metric (documented in docs/SCIENCE_LIMITS.md):
  brightness_snr = (Σ(frame − reference − annulus_bg) in aperture)
                   / sqrt(Σ variance_eff in aperture)
  position_shift = centroid(frame) − centroid(reference) in the aperture,
                   in pixels and arcsec, with uncertainty from centroid noise.
  combined = hypot(brightness_snr, position_shift_snr) when both available.

Wavelength check applies in ALL reference modes (median_others, first_epoch,
previous_epoch). Mismatched frames are flagged wavelength_mismatched=True with
the measured Δλ and are excluded from ranking (status=not_computed) so colour
effects are never silently ranked as temporal change.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

import numpy as np

from .adapters.spherex import FLAG_BITS, PIXEL_SCALE_ARCSEC

ReferenceKind = Literal["median_others", "first_epoch", "previous_epoch"]
MetricKind = Literal["brightness_snr", "position_shift", "combined"]

DEFAULT_APERTURE_PIX = 1.5  # ~1–2 SPHEREx pixels (6.15″ each)
DEFAULT_ANNULUS = (2.5, 4.0)  # inner, outer radius in pixels
# ~one D1 spectral resolution element at ~1.1 µm (R≈39 → Δλ≈λ/R≈0.028 µm).
# Also ≈ LVF gradient across a typical 0.2° cutout (~0.02 µm). See docs/SCIENCE_LIMITS.md.
DEFAULT_WAVELENGTH_TOL_UM = 0.03
MIN_WAVELENGTH_MATCHED_FRAMES = 2

# Mask contamination / bad pixels; keep SOURCE and FULLSAMPLE (informational).
_BAD_FLAG_NAMES = (
    "TRANSIENT",
    "OVERFLOW",
    "SUR_ERROR",
    "NONFUNC",
    "DICHROIC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "PHANMISS",
    "NONLINEAR",
    "PERSIST",
    "OUTLIER",
    "GHOST",
    "GHOST_FPA",
    "GHOST_EXT",
    "STREAK",
    "BLOOM",
    "SNOWBALL",
    "HALO",
    "SATELLITE_HALO",
)
BAD_FLAG_MASK = 0
for _name in _BAD_FLAG_NAMES:
    BAD_FLAG_MASK |= 1 << FLAG_BITS[_name]

# Saturation / bloom bits — Explanatory Supplement Table 16 / IRSA intro notebook:
#   bit 1 OVERFLOW = "Overflow / saturation threshold during SUR"
#   bit 26 BLOOM   = "Source blooming"
# Do not invent other bit numbers; quote the docs when changing this mask.
SATURATION_FLAG_MASK = (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["BLOOM"])
# Relaxed science mask for approximate photometry on saturated cores: keep all
# other bad bits, but allow OVERFLOW/BLOOM pixels through (always approximate=True).
RELAXED_BAD_FLAG_MASK = BAD_FLAG_MASK & ~SATURATION_FLAG_MASK


@dataclass
class FrameInput:
    epoch_id: str
    mjd: float
    image: np.ndarray
    variance: Optional[np.ndarray] = None
    flags: Optional[np.ndarray] = None
    wavelength_um: Optional[float] = None
    detector: Optional[int] = None
    x_pix: float = 0.0  # aperture / PM-prediction center in this frame's pixel grid
    y_pix: float = 0.0
    # Expected |hop| across the span (pixels) — sizes Bug 7 centroid window.
    expected_shift_pix: Optional[float] = None


@dataclass
class FrameChangeScore:
    epoch_id: str
    mjd: float
    wavelength_um: Optional[float]
    detector: Optional[int]
    score: Optional[float]
    score_err: Optional[float]
    score_unit: str
    brightness_snr: Optional[float]
    brightness_snr_err: Optional[float]
    position_shift_pix: Optional[float]
    position_shift_pix_err: Optional[float]
    position_shift_arcsec: Optional[float]
    position_shift_arcsec_err: Optional[float]
    centroid_x: Optional[float]
    centroid_y: Optional[float]
    masked_fraction: float
    n_aperture_pixels: int
    n_masked: int
    wavelength_mismatched: bool
    status: Literal["ok", "not_computed"]
    wavelength_diff_um: Optional[float] = None
    status_reason: str = ""
    approximate: bool = False
    approximate_reason: str = ""
    is_synthetic: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _wavelength_diff_um(
    a: Optional[float], b: Optional[float]
) -> Optional[float]:
    if a is None or b is None:
        return None
    return float(abs(a - b))


def _is_wavelength_mismatch(
    diff_um: Optional[float], tol_um: float
) -> bool:
    """True only when both wavelengths are known and |Δλ| exceeds tol."""
    if diff_um is None:
        return False
    return diff_um > tol_um


def _circular_mask(shape: tuple[int, int], x0: float, y0: float, r: float) -> np.ndarray:
    yy, xx = np.indices(shape)
    return (xx - x0) ** 2 + (yy - y0) ** 2 <= r**2


def _annulus_mask(
    shape: tuple[int, int], x0: float, y0: float, r_in: float, r_out: float
) -> np.ndarray:
    yy, xx = np.indices(shape)
    rr2 = (xx - x0) ** 2 + (yy - y0) ** 2
    return (rr2 >= r_in**2) & (rr2 <= r_out**2)


def _valid_pixels(
    image: np.ndarray,
    mask: np.ndarray,
    flags: Optional[np.ndarray],
    *,
    bad_mask: int = BAD_FLAG_MASK,
) -> np.ndarray:
    """Boolean mask of usable pixels inside `mask` (finite, not bad-flagged).

    SOURCE / FULLSAMPLE bits are informational and are NOT treated as bad.
    """
    ok = mask & np.isfinite(image)
    if flags is not None:
        fl = np.asarray(flags).astype(np.uint64)
        ok = ok & ((fl & bad_mask) == 0)
    return ok


def _annulus_background(
    image: np.ndarray,
    flags: Optional[np.ndarray],
    x0: float,
    y0: float,
    r_in: float,
    r_out: float,
) -> tuple[float, int]:
    am = _annulus_mask(image.shape, x0, y0, r_in, r_out)
    ok = _valid_pixels(image, am, flags)
    if not np.any(ok):
        return 0.0, 0
    return float(np.nanmedian(image[ok])), int(np.count_nonzero(ok))


def centroid_window_half_pix(
    expected_shift_pix: float,
    *,
    floor_pix: float = 2.0,
    psf_pix: float = 1.5,
) -> float:
    """Half-width of a PM-aware centroid window (Bug 7).

    Window grows with expected hop so slow movers stay near the fixed 1.5 px
    aperture while high-PM targets (Barnard's ~1–2 px/span) get a wider search.
    """
    hop = abs(float(expected_shift_pix))
    return float(max(floor_pix, hop + psf_pix))


def motion_windowed_centroid(
    image: np.ndarray,
    flags: Optional[np.ndarray],
    x_pred: float,
    y_pred: float,
    *,
    expected_shift_pix: float = 1.5,
    bad_mask: int = BAD_FLAG_MASK,
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float], float]:
    """Centroid inside a window centered on the PM prediction (float IMAGE).

    Returns (cx, cy, cx_err, cy_err, window_half_pix). None centroids when the
    window has no valid pixels (e.g. saturation-blanked core).
    """
    half = centroid_window_half_pix(expected_shift_pix)
    win = _circular_mask(image.shape, x_pred, y_pred, half)
    ok = _valid_pixels(image, win, flags, bad_mask=bad_mask)
    cx, cy, ex, ey = _weighted_centroid(image, ok)
    return cx, cy, ex, ey, half


def _weighted_centroid(
    image: np.ndarray,
    ok: np.ndarray,
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """Flux-weighted centroid and rough 1/SNR pixel uncertainty."""
    if not np.any(ok):
        return None, None, None, None
    yy, xx = np.indices(image.shape)
    w = np.clip(image[ok] - np.nanmin(image[ok]), 0, None)
    # Use absolute residual from median as weight floor
    med = float(np.nanmedian(image[ok]))
    w = np.abs(image[ok] - med) + 1e-6
    wsum = float(np.sum(w))
    if wsum <= 0:
        return None, None, None, None
    cx = float(np.sum(xx[ok] * w) / wsum)
    cy = float(np.sum(yy[ok] * w) / wsum)
    # Rough centroid uncertainty ~ FWHM/(2.35*SNR); use pixel scatter proxy
    snr = wsum / (np.std(image[ok]) * np.sqrt(np.count_nonzero(ok)) + 1e-9)
    pix_err = max(0.05, 1.5 / max(snr, 1.0))
    return cx, cy, pix_err, pix_err


def _brightness_residual_on_mask(
    image: np.ndarray,
    reference: np.ndarray,
    variance: Optional[np.ndarray],
    flags: Optional[np.ndarray],
    phot_mask: np.ndarray,
    x0: float,
    y0: float,
    annulus: tuple[float, float],
    *,
    bad_mask: int = BAD_FLAG_MASK,
) -> tuple[Optional[float], Optional[float], float, int, int, str]:
    """Core residual S/N on an arbitrary photometry mask."""
    n_ap = int(np.count_nonzero(phot_mask))
    if n_ap == 0:
        return None, None, 1.0, 0, 0, "photometry mask empty"

    ok = _valid_pixels(image, phot_mask, flags, bad_mask=bad_mask) & np.isfinite(reference)
    if variance is not None:
        ok = ok & np.isfinite(variance) & (variance > 0)
    n_ok = int(np.count_nonzero(ok))
    n_masked = n_ap - n_ok
    masked_fraction = float(n_masked / n_ap) if n_ap else 1.0
    if n_ok == 0:
        return None, None, masked_fraction, n_ap, n_masked, "all aperture pixels masked or NaN"

    bg, n_bg = _annulus_background(image - reference, flags, x0, y0, annulus[0], annulus[1])
    resid = (image - reference)[ok] - bg
    signal = float(np.sum(resid))

    if variance is not None:
        var_eff = np.asarray(variance, dtype=float)[ok] * 2.0
        sigma = float(np.sqrt(np.sum(var_eff)))
    else:
        am = _annulus_mask(image.shape, x0, y0, annulus[0], annulus[1])
        aok = _valid_pixels(image - reference, am, flags, bad_mask=bad_mask)
        if np.count_nonzero(aok) < 3:
            return None, None, masked_fraction, n_ap, n_masked, "no variance and insufficient annulus"
        sigma = float(np.std((image - reference)[aok]) * np.sqrt(n_ok))
        if sigma <= 0:
            return None, None, masked_fraction, n_ap, n_masked, "zero scatter in annulus"

    if sigma <= 0 or not np.isfinite(sigma):
        return None, None, masked_fraction, n_ap, n_masked, "non-positive uncertainty"
    snr = signal / sigma
    snr_err = 1.0
    reason = ""
    if variance is None:
        reason = "uncertainty from annulus scatter (no VARIANCE extension)"
    if n_bg == 0:
        reason = (reason + "; " if reason else "") + "annulus empty — background set to 0"
    return snr, snr_err, masked_fraction, n_ap, n_masked, reason


def _brightness_residual(
    image: np.ndarray,
    reference: np.ndarray,
    variance: Optional[np.ndarray],
    flags: Optional[np.ndarray],
    x0: float,
    y0: float,
    aperture_pix: float,
    annulus: tuple[float, float],
    *,
    allow_saturated_approx: bool = True,
) -> tuple[Optional[float], Optional[float], float, int, int, str, bool, str]:
    """
    Returns (snr, snr_err, masked_fraction, n_ap, n_masked, reason, approximate, approx_reason).

    If the core aperture is fully masked by saturation (OVERFLOW/BLOOM), try:
      1) ring photometry outside the saturated core (approximate)
      2) relaxed mask ignoring OVERFLOW/BLOOM (approximate)
    Otherwise report not computed: source saturated with masked counts.
    """
    ap = _circular_mask(image.shape, x0, y0, aperture_pix)
    snr, snr_err, masked_fraction, n_ap, n_masked, reason = _brightness_residual_on_mask(
        image, reference, variance, flags, ap, x0, y0, annulus, bad_mask=BAD_FLAG_MASK
    )
    if snr is not None:
        return snr, snr_err, masked_fraction, n_ap, n_masked, reason, False, ""

    if not allow_saturated_approx or flags is None:
        if reason == "all aperture pixels masked or NaN":
            reason = (
                f"not computed: source saturated (masked {n_masked}/{n_ap} aperture pixels)"
            )
        return None, None, masked_fraction, n_ap, n_masked, reason, False, ""

    # Detect whether saturation bits dominate the core mask
    fl = np.asarray(flags).astype(np.uint64)
    core_sat = ap & ((fl & SATURATION_FLAG_MASK) != 0)
    sat_frac = float(np.count_nonzero(core_sat) / n_ap) if n_ap else 0.0

    # 1) Ring outside the saturated core — prefer strict FLAGS, then relaxed.
    r_in = max(aperture_pix, 1.5)
    radii = (max(annulus[1], r_in * 2.5), r_in * 4.0, r_in * 6.0)
    reason_r = "ring not attempted"
    for bad_mask, label in (
        (BAD_FLAG_MASK, "ring photometry outside masked core"),
        (
            RELAXED_BAD_FLAG_MASK,
            "ring photometry with OVERFLOW/BLOOM ignored (Explanatory Supp. Table 16 bits 1,26)",
        ),
    ):
        for r_out in radii:
            ring = _annulus_mask(image.shape, x0, y0, r_in, r_out)
            bg_ann = (r_out, min(r_out * 1.5, r_out + 4.0))
            snr_r, err_r, mf_r, n_ap_r, n_masked_r, reason_r = _brightness_residual_on_mask(
                image, reference, variance, flags, ring, x0, y0, bg_ann,
                bad_mask=bad_mask,
            )
            if snr_r is not None:
                approx_reason = (
                    f"approximate (saturated core); {label} "
                    f"(r={r_in:.1f}–{r_out:.1f} px; core sat frac={sat_frac:.2f})"
                )
                note = (reason_r + "; " if reason_r else "") + approx_reason
                return snr_r, err_r, mf_r, n_ap_r, n_masked_r, note, True, approx_reason

    # 2) Relaxed mask on the original aperture: ignore OVERFLOW/BLOOM only
    snr_x, err_x, mf_x, n_ap_x, n_masked_x, reason_x = _brightness_residual_on_mask(
        image, reference, variance, flags, ap, x0, y0, annulus,
        bad_mask=RELAXED_BAD_FLAG_MASK,
    )
    if snr_x is not None:
        approx_reason = (
            "approximate (saturated core); ignored OVERFLOW/BLOOM flag bits "
            "(Explanatory Supplement Table 16 bits 1 and 26)"
        )
        note = (reason_x + "; " if reason_x else "") + approx_reason
        return snr_x, err_x, mf_x, n_ap_x, n_masked_x, note, True, approx_reason

    reason = (
        f"not computed: source saturated (masked {n_masked}/{n_ap} aperture pixels; "
        f"ring also insufficient: {reason_r})"
    )
    return None, None, masked_fraction, n_ap, n_masked, reason, False, ""


def _wavelength_peers(
    frames: list[FrameInput],
    idx: int,
    tol_um: float,
) -> list[int]:
    """Indices of frames within tol of frame idx's wavelength (excluding idx)."""
    w0 = frames[idx].wavelength_um
    if w0 is None:
        return [i for i in range(len(frames)) if i != idx]
    peers = []
    for i, fr in enumerate(frames):
        if i == idx:
            continue
        if fr.wavelength_um is None:
            continue
        if abs(fr.wavelength_um - w0) <= tol_um:
            peers.append(i)
    return peers


def _build_reference(
    frames: list[FrameInput],
    idx: int,
    kind: ReferenceKind,
    tol_um: float,
) -> tuple[np.ndarray, bool, Optional[float], str]:
    """
    Returns (reference_image, wavelength_mismatched, wavelength_diff_um, note).

    wavelength_mismatched is True whenever the frame's λ disagrees with the
    reference λ (first/previous) or when no λ-matched peers exist (median).
    Diff is the measured |Δλ| in µm when both wavelengths are known.
    """
    shape = frames[idx].image.shape
    w_frame = frames[idx].wavelength_um

    if kind == "first_epoch":
        diff = _wavelength_diff_um(w_frame, frames[0].wavelength_um)
        mismatched = _is_wavelength_mismatch(diff, tol_um)
        note = "reference=first_epoch"
        if mismatched:
            note += f" (wavelength-mismatched |Δλ|={diff:.4f} µm > ±{tol_um} µm)"
        return (
            np.asarray(frames[0].image, dtype=float),
            mismatched,
            diff,
            note,
        )

    if kind == "previous_epoch":
        if idx == 0:
            return (
                np.asarray(frames[0].image, dtype=float),
                False,
                0.0 if w_frame is not None else None,
                "reference=previous_epoch (self for epoch 0)",
            )
        diff = _wavelength_diff_um(w_frame, frames[idx - 1].wavelength_um)
        mismatched = _is_wavelength_mismatch(diff, tol_um)
        note = "reference=previous_epoch"
        if mismatched:
            note += f" (wavelength-mismatched |Δλ|={diff:.4f} µm > ±{tol_um} µm)"
        return (
            np.asarray(frames[idx - 1].image, dtype=float),
            mismatched,
            diff,
            note,
        )

    # median_others — require wavelength-matched peers; do not silently fall back
    peers = _wavelength_peers(frames, idx, tol_um)
    if len(peers) < 1:
        # No λ-matched peers: exclude from ranking (caller sets not_computed).
        diffs = []
        for j, fr in enumerate(frames):
            if j == idx:
                continue
            d = _wavelength_diff_um(w_frame, fr.wavelength_um)
            if d is not None:
                diffs.append(d)
        diff = float(min(diffs)) if diffs else None
        note = (
            "no wavelength-matched peers within "
            f"±{tol_um} µm — excluded from change ranking"
        )
        return np.asarray(frames[idx].image, dtype=float), True, diff, note

    imgs = [np.asarray(frames[i].image, dtype=float) for i in peers]
    h = min(im.shape[0] for im in imgs + [np.asarray(frames[idx].image)])
    w = min(im.shape[1] for im in imgs + [np.asarray(frames[idx].image)])
    shape_note = ""
    if any(im.shape != (h, w) for im in imgs) or shape != (h, w):
        shape_note = "; cropped to common shape (frames not on identical grid)"
    stack = np.stack([im[:h, :w] for im in imgs], axis=0)
    with np.errstate(all="ignore"):
        ref = np.nanmedian(stack, axis=0)
    if not np.any(np.isfinite(ref)):
        ref = np.zeros((h, w), dtype=float)
        shape_note += "; reference all-NaN — substituted zeros"
    out = np.full(shape, np.nan, dtype=float)
    hh = min(shape[0], ref.shape[0])
    ww = min(shape[1], ref.shape[1])
    out[:hh, :ww] = ref[:hh, :ww]
    # Matched peers → report max |Δλ| among peers as the measured difference
    peer_diffs = [
        _wavelength_diff_um(w_frame, frames[i].wavelength_um) for i in peers
    ]
    peer_diffs_f = [d for d in peer_diffs if d is not None]
    diff = float(max(peer_diffs_f)) if peer_diffs_f else None
    note = "reference=median of wavelength-matched others" + shape_note
    return out, False, diff, note


def score_frames(
    frames: list[FrameInput],
    *,
    metric: MetricKind = "brightness_snr",
    reference: ReferenceKind = "median_others",
    aperture_pix: float = DEFAULT_APERTURE_PIX,
    annulus: tuple[float, float] = DEFAULT_ANNULUS,
    wavelength_tol_um: float = DEFAULT_WAVELENGTH_TOL_UM,
    pixel_scale_arcsec: float = PIXEL_SCALE_ARCSEC,
    is_synthetic: bool = False,
    allow_saturated_approx: bool = True,
    use_motion_window: bool = True,
) -> list[FrameChangeScore]:
    """Compute per-frame change scores. Frames must share a common pixel grid.

    When ``use_motion_window`` is True (default), centroids use a PM-sized
    window around the predicted pixel (Bug 7). Photometry stays on the
    fixed ``aperture_pix`` radius for stable brightness S/N.
    """
    if not frames:
        return []

    def _centroid_at(
        image: np.ndarray,
        flags: Optional[np.ndarray],
        x0: float,
        y0: float,
        expected_hop: Optional[float],
    ) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float], float]:
        if use_motion_window:
            hop = float(expected_hop) if expected_hop is not None else float(aperture_pix)
            cx, cy, ex, ey, half = motion_windowed_centroid(
                image, flags, x0, y0, expected_shift_pix=hop
            )
            return cx, cy, ex, ey, half
        ap = _circular_mask(image.shape, x0, y0, aperture_pix)
        ok = _valid_pixels(image, ap, flags)
        cx, cy, ex, ey = _weighted_centroid(image, ok)
        return cx, cy, ex, ey, float(aperture_pix)

    # Reference centroid from first *wavelength-matched* usable reference when possible
    ref_cx = ref_cy = None
    ref_img0, mis0, _, _ = _build_reference(frames, 0, reference, wavelength_tol_um)
    if not mis0:
        ref_cx, ref_cy, _, _, _ = _centroid_at(
            ref_img0,
            frames[0].flags,
            frames[0].x_pix,
            frames[0].y_pix,
            frames[0].expected_shift_pix,
        )

    results: list[FrameChangeScore] = []
    for i, fr in enumerate(frames):
        ref_img, mismatched, wave_diff, ref_note = _build_reference(
            frames, i, reference, wavelength_tol_um
        )
        notes = [ref_note]
        (
            b_snr,
            b_err,
            masked_frac,
            n_ap,
            n_masked,
            b_reason,
            approx,
            approx_reason,
        ) = _brightness_residual(
            np.asarray(fr.image, dtype=float),
            ref_img,
            fr.variance,
            fr.flags,
            fr.x_pix,
            fr.y_pix,
            aperture_pix,
            annulus,
            allow_saturated_approx=allow_saturated_approx,
        )
        if b_reason:
            notes.append(b_reason)
        if approx and approx_reason:
            notes.append(approx_reason)

        # Position shift vs reference centroid (Bug 7 window when enabled)
        cx, cy, cx_err, cy_err, half = _centroid_at(
            np.asarray(fr.image, dtype=float),
            fr.flags,
            fr.x_pix,
            fr.y_pix,
            fr.expected_shift_pix,
        )
        if use_motion_window:
            notes.append(f"centroid_window_half_pix={half:.2f}")
        shift_pix = shift_pix_err = shift_as = shift_as_err = None
        if cx is not None and cy is not None and ref_cx is not None and ref_cy is not None:
            dx = cx - ref_cx
            dy = cy - ref_cy
            shift_pix = float(np.hypot(dx, dy))
            if cx_err is not None and cy_err is not None:
                shift_pix_err = float(np.hypot(cx_err, cy_err))
            else:
                shift_pix_err = None
            shift_as = shift_pix * pixel_scale_arcsec
            shift_as_err = (
                None if shift_pix_err is None else shift_pix_err * pixel_scale_arcsec
            )

        score = score_err = None
        unit = "dimensionless (S/N)"
        status: Literal["ok", "not_computed"] = "ok"
        status_reason = ""

        # Never silently rank wavelength-mismatched frames as real changes.
        if mismatched:
            notes.append("wavelength_mismatched")
            status = "not_computed"
            status_reason = (
                "wavelength-mismatched"
                + (
                    f" (|Δλ|={wave_diff:.4f} µm > ±{wavelength_tol_um} µm)"
                    if wave_diff is not None
                    else f" (no peers within ±{wavelength_tol_um} µm)"
                )
            )
            score = None
            score_err = None
        elif metric == "brightness_snr":
            score, score_err = b_snr, b_err
            unit = "dimensionless (brightness S/N)"
            if score is None:
                status = "not_computed"
                status_reason = b_reason or "brightness S/N not computed"
        elif metric == "position_shift":
            score, score_err = shift_as, shift_as_err
            unit = "arcsec"
            if score is None:
                status = "not_computed"
                status_reason = "centroid not computed (masked/empty aperture)"
        else:  # combined
            unit = "dimensionless (hypot of brightness S/N and shift S/N)"
            parts = []
            if b_snr is not None:
                parts.append(abs(b_snr))
            if shift_pix is not None and shift_pix_err and shift_pix_err > 0:
                parts.append(abs(shift_pix / shift_pix_err))
            if not parts:
                status = "not_computed"
                status_reason = "neither brightness nor position S/N available"
            else:
                score = float(np.hypot(*parts)) if len(parts) > 1 else float(parts[0])
                score_err = 1.0  # approximate

        results.append(
            FrameChangeScore(
                epoch_id=fr.epoch_id,
                mjd=fr.mjd,
                wavelength_um=fr.wavelength_um,
                detector=fr.detector,
                score=score,
                score_err=score_err,
                score_unit=unit,
                brightness_snr=None if mismatched else b_snr,
                brightness_snr_err=None if mismatched else b_err,
                position_shift_pix=shift_pix,
                position_shift_pix_err=shift_pix_err,
                position_shift_arcsec=shift_as,
                position_shift_arcsec_err=shift_as_err,
                centroid_x=cx,
                centroid_y=cy,
                masked_fraction=masked_frac,
                n_aperture_pixels=n_ap,
                n_masked=n_masked,
                wavelength_mismatched=mismatched,
                wavelength_diff_um=wave_diff,
                status=status,
                status_reason=status_reason,
                approximate=False if mismatched else approx,
                approximate_reason="" if mismatched else approx_reason,
                is_synthetic=is_synthetic,
                notes=notes,
            )
        )
    return results


def wavelength_match_summary(
    scores: list[FrameChangeScore],
    *,
    wavelength_tol_um: float = DEFAULT_WAVELENGTH_TOL_UM,
    min_matched: int = MIN_WAVELENGTH_MATCHED_FRAMES,
) -> dict[str, Any]:
    """Count excluded λ-mismatched frames; gate the overall slider status."""
    n_total = len(scores)
    n_excluded = sum(1 for s in scores if s.wavelength_mismatched)
    n_matched_ok = sum(
        1 for s in scores if s.status == "ok" and not s.wavelength_mismatched
    )
    too_few = n_matched_ok < min_matched
    return {
        "wavelength_tol_um": wavelength_tol_um,
        "n_frames": n_total,
        "n_wavelength_excluded": n_excluded,
        "n_wavelength_matched_ok": n_matched_ok,
        "min_wavelength_matched_frames": min_matched,
        "too_few_wavelength_matched_frames": too_few,
        "wavelength_status": (
            "too_few_wavelength_matched_frames" if too_few else "ok"
        ),
        "message": (
            "too few wavelength-matched frames"
            if too_few
            else f"{n_excluded} frame(s) excluded as wavelength-mismatched"
        ),
    }


def filter_by_score_range(
    scores: list[FrameChangeScore],
    lo: Optional[float],
    hi: Optional[float],
) -> list[FrameChangeScore]:
    """Keep frames whose score is within [lo, hi]. not_computed frames are dropped when filtering."""
    out = []
    for s in scores:
        if s.status != "ok" or s.score is None:
            continue
        if lo is not None and s.score < lo:
            continue
        if hi is not None and s.score > hi:
            continue
        out.append(s)
    return out


def load_demo_frame_inputs(
    demo_dir: Any,
    *,
    ra: float,
    dec: float,
    target_ra: float,
    target_dec: float,
    pixel_scale_arcsec: float = PIXEL_SCALE_ARCSEC,
) -> tuple[list[FrameInput], float, float]:
    """
    Load float32 IMAGE (+ optional FLAGS) bins from a demo-data target folder.

    Prefer per-frame ``predicted_x_pix`` / ``predicted_y_pix`` (PM on the fixed
    cutout grid). Fallback: TAN offset of ``(ra, dec)`` from cutout CRVAL.
    Returns (frames, mean_x_pix, mean_y_pix).
    """
    from pathlib import Path

    demo_dir = Path(demo_dir)
    manifest_path = demo_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"no manifest in {demo_dir}")
    import json

    man = json.loads(manifest_path.read_text(encoding="utf-8"))
    frames_meta = man.get("frames") or []
    if not frames_meta:
        raise FileNotFoundError(f"no frames in {manifest_path}")

    # Pack-level hop for Bug 7 window sizing
    hop = man.get("predicted_shift_pix")
    if hop is None:
        vis = man.get("visibility") or {}
        hop = vis.get("predicted_shift_pix_first_to_last")
    if hop is None:
        hops = [
            abs(float(f["predicted_shift_pix_from_epoch0"]))
            for f in frames_meta
            if f.get("predicted_shift_pix_from_epoch0") is not None
        ]
        hop = max(hops) if hops else None
    expected_hop = float(hop) if hop is not None else None

    shape0 = tuple(frames_meta[0].get("float_shape") or [29, 29])

    loaded: list[tuple[dict, np.ndarray, Optional[np.ndarray]]] = []
    for fr in frames_meta:
        shape = tuple(fr.get("float_shape") or shape0)
        h, w = int(shape[0]), int(shape[1])
        # Skip truncated edge cutouts (precache filter ≥80; defend older packs)
        if min(h, w) < 80:
            continue
        bin_name = fr.get("float_bin")
        if not bin_name:
            continue
        bin_path = demo_dir / bin_name
        if not bin_path.exists():
            continue
        img = np.fromfile(bin_path, dtype=np.float32).reshape(h, w).astype(float)
        flags = None
        flags_name = fr.get("flags_bin")
        if flags_name:
            fp = demo_dir / flags_name
            if fp.exists():
                raw = fp.read_bytes()
                n = h * w
                if len(raw) == n * 2:
                    flags = np.frombuffer(raw, dtype=np.int16).reshape(h, w).astype(np.int32)
                elif len(raw) == n * 4:
                    flags = np.frombuffer(raw, dtype=np.int32).reshape(h, w)
                elif len(raw) == n:
                    flags = np.frombuffer(raw, dtype=np.uint8).reshape(h, w).astype(np.int32)
        loaded.append((fr, img, flags))
    if not loaded:
        raise FileNotFoundError(f"no float bins readable in {demo_dir}")

    # Common grid: majority native shape (skip odd reprojected outliers)
    from collections import Counter

    shape_counts = Counter(im.shape for _, im, _ in loaded)
    common_shape = shape_counts.most_common(1)[0][0]
    ch, cw = common_shape
    # Fallback aperture: TAN offset from cutout CRVAL to request (ra, dec)
    scale_deg = pixel_scale_arcsec / 3600.0
    cosd = float(np.cos(np.deg2rad(target_dec)))
    dx = (ra - target_ra) * cosd / scale_deg
    dy = (dec - target_dec) / scale_deg
    fallback_x = (cw - 1) / 2.0 - dx
    fallback_y = (ch - 1) / 2.0 + dy

    out: list[FrameInput] = []
    xs: list[float] = []
    ys: list[float] = []
    for fr, img, flags in loaded:
        if img.shape != common_shape:
            # Center-crop larger frames; skip smaller
            if img.shape[0] < ch or img.shape[1] < cw:
                continue
            y0 = (img.shape[0] - ch) // 2
            x0 = (img.shape[1] - cw) // 2
            img = img[y0 : y0 + ch, x0 : x0 + cw]
            if flags is not None:
                flags = flags[y0 : y0 + ch, x0 : x0 + cw]
        if fr.get("predicted_x_pix") is not None and fr.get("predicted_y_pix") is not None:
            x_pix = float(fr["predicted_x_pix"])
            y_pix = float(fr["predicted_y_pix"])
            # If we center-cropped, predicted coords assumed on native — skip adjust
            # when shapes already matched (majority path).
        else:
            x_pix, y_pix = fallback_x, fallback_y
        xs.append(x_pix)
        ys.append(y_pix)
        # No VARIANCE sidecars in demo pack — metric falls back to annulus scatter
        out.append(
            FrameInput(
                epoch_id=str(fr["epoch_id"]),
                mjd=float(fr["mjd"]),
                image=img,
                variance=None,
                flags=flags,
                wavelength_um=fr.get("central_wavelength_um"),
                detector=fr.get("detector"),
                x_pix=float(x_pix),
                y_pix=float(y_pix),
                expected_shift_pix=expected_hop,
            )
        )
    if not out:
        raise FileNotFoundError(f"no common-shape float bins in {demo_dir}")
    return out, float(np.mean(xs)), float(np.mean(ys))


def net_motion(
    scores: list[FrameChangeScore],
    *,
    pixel_scale_arcsec: float = PIXEL_SCALE_ARCSEC,
) -> dict[str, Any]:
    """
    Total displacement and apparent motion from centroids with real epochs.
    Requires ≥3 points with centroids; otherwise returns too_few_points.
    """
    pts = [
        s
        for s in scores
        if s.centroid_x is not None and s.centroid_y is not None and np.isfinite(s.mjd)
    ]
    pts = sorted(pts, key=lambda s: s.mjd)
    if len(pts) < 3:
        return {
            "status": "too_few_points",
            "n_points": len(pts),
            "message": "too few points to estimate motion",
            "total_displacement_arcsec": None,
            "total_displacement_arcsec_err": None,
            "pm_arcsec_yr": None,
            "pm_arcsec_yr_err": None,
            "uncertainty_note": "no uncertainty available",
        }
    x0, y0 = pts[0].centroid_x, pts[0].centroid_y
    x1, y1 = pts[-1].centroid_x, pts[-1].centroid_y
    dpix = float(np.hypot(x1 - x0, y1 - y0))
    # Endpoint centroid errors if present
    e0 = pts[0].position_shift_pix_err or 0.2
    e1 = pts[-1].position_shift_pix_err or 0.2
    dpix_err = float(np.hypot(e0, e1))
    das = dpix * pixel_scale_arcsec
    das_err = dpix_err * pixel_scale_arcsec
    dt_yr = (pts[-1].mjd - pts[0].mjd) / 365.25
    if dt_yr <= 0:
        return {
            "status": "ok",
            "n_points": len(pts),
            "total_displacement_arcsec": das,
            "total_displacement_arcsec_err": das_err,
            "pm_arcsec_yr": None,
            "pm_arcsec_yr_err": None,
            "uncertainty_note": "non-positive time baseline — rate not computed",
        }
    pm = das / dt_yr
    pm_err = das_err / dt_yr
    return {
        "status": "ok",
        "n_points": len(pts),
        "total_displacement_arcsec": das,
        "total_displacement_arcsec_err": das_err,
        "pm_arcsec_yr": pm,
        "pm_arcsec_yr_err": pm_err,
        "dt_yr": dt_yr,
        "uncertainty_note": (
            f"endpoint centroid σ propagated; pixel scale {pixel_scale_arcsec}″ "
            "(SPHEREx Spectral Image)"
        ),
        "trail": [
            {
                "epoch_id": s.epoch_id,
                "mjd": s.mjd,
                "x": s.centroid_x,
                "y": s.centroid_y,
                "score": s.score,
            }
            for s in pts
        ],
    }
