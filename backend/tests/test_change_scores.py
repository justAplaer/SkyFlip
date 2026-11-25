"""Unit tests for change-score metric (static star, synthetic mover, NaN, λ-mismatch)."""

from __future__ import annotations

import numpy as np
import pytest

from app.change_scores import (
    FrameInput,
    centroid_window_half_pix,
    filter_by_score_range,
    motion_windowed_centroid,
    net_motion,
    score_frames,
)


def _gauss_star(
    shape: tuple[int, int],
    x0: float,
    y0: float,
    amp: float = 50.0,
    sigma: float = 1.2,
    bg: float = 10.0,
    rng: np.random.Generator | None = None,
    noise: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.indices(shape)
    img = bg + amp * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma**2))
    if rng is not None and noise > 0:
        img = img + rng.normal(0, noise, size=shape)
    var = np.full(shape, max(noise, 0.5) ** 2, dtype=float)
    return img.astype(float), var


def _static_frames(n: int = 8, seed: int = 1) -> list[FrameInput]:
    rng = np.random.default_rng(seed)
    shape = (32, 32)
    cx, cy = 16.0, 16.0
    frames = []
    for i in range(n):
        img, var = _gauss_star(shape, cx, cy, rng=rng, noise=0.8)
        frames.append(
            FrameInput(
                epoch_id=f"static-{i}",
                mjd=60000.0 + i * 10,
                image=img,
                variance=var,
                flags=np.zeros(shape, dtype=int),
                wavelength_um=1.5,
                detector=1,
                x_pix=cx,
                y_pix=cy,
            )
        )
    return frames


def _mover_frames(
    n: int = 8,
    seed: int = 42,
    step_pix: float = 0.7,
    inject_at: tuple[int, ...] = (5, 6, 7),
) -> list[FrameInput]:
    """Static star in early frames; synthetic mover injected in inject_at indices."""
    rng = np.random.default_rng(seed)
    shape = (32, 32)
    cx, cy = 16.0, 16.0
    frames = []
    for i in range(n):
        if i in inject_at:
            # Injected mover: bright source shifted + extra flux (is_synthetic)
            mx = cx + step_pix * (i - inject_at[0] + 1)
            my = cy + step_pix * (i - inject_at[0] + 1)
            img, var = _gauss_star(shape, mx, my, amp=80.0, rng=rng, noise=0.8)
        else:
            img, var = _gauss_star(shape, cx, cy, amp=50.0, rng=rng, noise=0.8)
        frames.append(
            FrameInput(
                epoch_id=f"mover-{i}",
                mjd=60000.0 + i * 30,
                image=img,
                variance=var,
                flags=np.zeros(shape, dtype=int),
                wavelength_um=1.5,
                detector=1,
                x_pix=cx,
                y_pix=cy,
            )
        )
    return frames


def test_static_star_low_brightness_scores():
    frames = _static_frames()
    scores = score_frames(frames, metric="brightness_snr", reference="median_others")
    assert len(scores) == len(frames)
    for s in scores:
        assert s.status == "ok"
        assert s.score is not None
        assert s.score_err is not None
        # Residual vs median of peers should be near noise (few σ)
        assert abs(s.score) < 8.0, f"static star unexpectedly high S/N={s.score}"
        assert not s.wavelength_mismatched


def test_injected_mover_high_score_in_right_frames():
    inject = (5, 6, 7)
    frames = _mover_frames(inject_at=inject)
    scores = score_frames(
        frames,
        metric="brightness_snr",
        reference="median_others",
        is_synthetic=True,
    )
    for s in scores:
        assert s.is_synthetic is True
    # Injected frames should have higher |score| than early static ones
    static_abs = [abs(s.score or 0) for s in scores if int(s.epoch_id.split("-")[1]) < 5]
    inject_abs = [abs(s.score or 0) for s in scores if int(s.epoch_id.split("-")[1]) in inject]
    assert max(static_abs) < min(inject_abs) or np.mean(inject_abs) > np.mean(static_abs) + 2


def test_injected_mover_position_shift():
    # Keep the mover inside a wider aperture so the centroid can track it.
    inject = (3, 4, 5)
    frames = _mover_frames(n=6, inject_at=inject, step_pix=0.5)
    scores = score_frames(
        frames,
        metric="position_shift",
        reference="first_epoch",
        aperture_pix=3.0,
    )
    static_shifts = [
        s.position_shift_pix or 0.0
        for i, s in enumerate(scores)
        if i not in inject and s.position_shift_pix is not None
    ]
    inject_shifts = [
        s.position_shift_pix or 0.0
        for i, s in enumerate(scores)
        if i in inject and s.position_shift_pix is not None
    ]
    assert inject_shifts and static_shifts
    assert np.mean(inject_shifts) > np.mean(static_shifts)
    for i, s in enumerate(scores):
        if i in inject:
            assert s.status == "ok"
            assert s.position_shift_arcsec is not None
            assert s.score_err is not None or s.position_shift_arcsec_err is not None


def test_all_nan_frame_not_computed():
    frames = _static_frames(n=4)
    frames[2].image = np.full_like(frames[2].image, np.nan)
    scores = score_frames(frames, metric="brightness_snr")
    assert scores[2].status == "not_computed"
    assert scores[2].score is None
    assert "masked" in scores[2].status_reason.lower() or "nan" in scores[2].status_reason.lower()
    # Neighbors still computed
    assert scores[0].status == "ok"
    assert scores[1].status == "ok"


def test_no_variance_all_masked_not_computed():
    shape = (16, 16)
    frames = [
        FrameInput(
            epoch_id="a",
            mjd=1.0,
            image=np.ones(shape),
            variance=None,
            flags=np.ones(shape, dtype=int),  # all flagged
            wavelength_um=1.0,
            x_pix=8,
            y_pix=8,
        ),
        FrameInput(
            epoch_id="b",
            mjd=2.0,
            image=np.ones(shape) * 2,
            variance=None,
            flags=np.ones(shape, dtype=int),
            wavelength_um=1.0,
            x_pix=8,
            y_pix=8,
        ),
    ]
    scores = score_frames(frames, metric="brightness_snr")
    for s in scores:
        assert s.status == "not_computed"
        assert s.score is None


def test_wavelength_mismatched_flagged_all_reference_modes():
    """Bug 4: mismatched λ → wavelength_mismatched=True in ALL three modes."""
    from app.change_scores import DEFAULT_WAVELENGTH_TOL_UM, wavelength_match_summary

    shape = (24, 24)
    rng = np.random.default_rng(7)
    waves = [1.00, 1.01, 1.00, 1.40]  # last exceeds 0.03 µm tol vs ~1.0
    frames = []
    for i, wl in enumerate(waves):
        # Colour-like amp drift with wavelength (static sky, not a mover)
        amp = 40.0 + 80.0 * (wl - 1.0)
        img, var = _gauss_star(shape, 12, 12, amp=amp, rng=rng, noise=0.5)
        frames.append(
            FrameInput(
                epoch_id=f"wl-{i}",
                mjd=60000 + i,
                image=img,
                variance=var,
                flags=np.zeros(shape, dtype=int),
                wavelength_um=wl,
                x_pix=12,
                y_pix=12,
            )
        )

    for mode in ("median_others", "first_epoch", "previous_epoch"):
        scores = score_frames(
            frames,
            metric="brightness_snr",
            reference=mode,  # type: ignore[arg-type]
            wavelength_tol_um=DEFAULT_WAVELENGTH_TOL_UM,
        )
        assert scores[3].wavelength_mismatched is True, mode
        assert scores[3].status == "not_computed", mode
        assert scores[3].score is None, mode
        assert scores[3].wavelength_diff_um is not None
        assert scores[3].wavelength_diff_um > DEFAULT_WAVELENGTH_TOL_UM
        # Matched frames stay matched
        assert scores[0].wavelength_mismatched is False, mode
        assert scores[0].status == "ok", mode
        assert scores[0].wavelength_diff_um is not None
        assert scores[0].wavelength_diff_um <= DEFAULT_WAVELENGTH_TOL_UM


def test_colour_gradient_does_not_rank_high_after_exclusion():
    """Synthetic static star with λ-driven flux must not top-rank once mismatches excluded."""
    from app.change_scores import DEFAULT_WAVELENGTH_TOL_UM

    shape = (24, 24)
    rng = np.random.default_rng(11)
    frames = []
    for i, wl in enumerate([1.0, 1.0, 1.0, 1.5, 1.6]):
        amp = 30.0 + 200.0 * abs(wl - 1.0)  # strong colour gradient
        img, var = _gauss_star(shape, 12, 12, amp=amp, rng=rng, noise=0.4)
        frames.append(
            FrameInput(
                epoch_id=f"colour-{i}",
                mjd=60000 + i,
                image=img,
                variance=var,
                flags=np.zeros(shape, dtype=int),
                wavelength_um=wl,
                x_pix=12,
                y_pix=12,
            )
        )
    scores = score_frames(
        frames,
        metric="brightness_snr",
        reference="median_others",
        wavelength_tol_um=DEFAULT_WAVELENGTH_TOL_UM,
    )
    ranked = sorted(
        [s for s in scores if s.status == "ok" and s.score is not None],
        key=lambda s: abs(s.score or 0),
        reverse=True,
    )
    assert ranked, "expected some λ-matched scores"
    assert all(not s.wavelength_mismatched for s in ranked)
    # Colour-outlier epochs must be excluded, not top-ranked
    assert all(s.epoch_id.startswith("colour-") and int(s.epoch_id.split("-")[1]) < 3 for s in ranked)
    for s in scores:
        if s.wavelength_um and s.wavelength_um >= 1.5:
            assert s.wavelength_mismatched is True
            assert s.status == "not_computed"


def test_seeded_mover_still_high_score_with_tight_tol():
    """λ-matched mover still ranks high after Bug 4 exclusion rules."""
    inject = (5, 6, 7)
    frames = _mover_frames(inject_at=inject)
    scores = score_frames(
        frames,
        metric="brightness_snr",
        reference="median_others",
        wavelength_tol_um=0.03,
        is_synthetic=True,
    )
    assert all(not s.wavelength_mismatched for s in scores)
    static_abs = [abs(s.score or 0) for s in scores if int(s.epoch_id.split("-")[1]) < 5]
    inject_abs = [abs(s.score or 0) for s in scores if int(s.epoch_id.split("-")[1]) in inject]
    assert np.mean(inject_abs) > np.mean(static_abs) + 1.5


def test_filter_by_score_range_drops_not_computed():
    frames = _static_frames(n=4)
    frames[1].image = np.full_like(frames[1].image, np.nan)
    scores = score_frames(frames)
    # Force a known range: keep only |score| above a tiny floor among ok frames
    ok_scores = [s.score for s in scores if s.status == "ok" and s.score is not None]
    assert ok_scores
    lo = min(ok_scores) - 1
    hi = max(ok_scores) + 1
    kept = filter_by_score_range(scores, lo, hi)
    assert all(s.status == "ok" for s in kept)
    assert all(s.epoch_id != "static-1" for s in kept)


def test_net_motion_too_few_points():
    frames = _static_frames(n=2)
    scores = score_frames(frames, metric="position_shift")
    motion = net_motion(scores)
    assert motion["status"] == "too_few_points"
    assert motion["pm_arcsec_yr"] is None
    assert "too few" in motion["message"]


def test_net_motion_with_epochs():
    frames = _mover_frames(n=6, inject_at=(3, 4, 5), step_pix=0.8)
    scores = score_frames(frames, metric="combined", reference="first_epoch")
    motion = net_motion(scores)
    assert motion["status"] == "ok"
    assert motion["n_points"] >= 3
    assert motion["total_displacement_arcsec"] is not None
    assert motion["total_displacement_arcsec_err"] is not None
    assert motion["pm_arcsec_yr"] is not None
    assert motion["pm_arcsec_yr_err"] is not None


def test_reference_previous_epoch():
    frames = _static_frames(n=4)
    scores = score_frames(frames, reference="previous_epoch")
    assert all(s.status == "ok" for s in scores)
    assert any("previous_epoch" in n for n in scores[1].notes)


def test_combined_metric_unit():
    frames = _static_frames(n=4)
    scores = score_frames(frames, metric="combined")
    for s in scores:
        if s.status == "ok":
            assert "S/N" in s.score_unit or "dimensionless" in s.score_unit
            assert s.score_err is not None


def test_saturated_core_returns_approximate_ring_score():
    """Bug 2: core OVERFLOW/BLOOM masked, wings intact → approximate score."""
    from app.adapters.spherex import FLAG_BITS
    from app.change_scores import SATURATION_FLAG_MASK

    shape = (32, 32)
    rng = np.random.default_rng(21)
    cx, cy = 16.0, 16.0
    frames = []
    for i in range(4):
        img, var = _gauss_star(shape, cx, cy, amp=80.0, sigma=2.5, rng=rng, noise=0.5)
        flags = np.zeros(shape, dtype=np.int64)
        yy, xx = np.indices(shape)
        core = (xx - cx) ** 2 + (yy - cy) ** 2 <= 1.5**2
        flags[core] = (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["BLOOM"])
        assert SATURATION_FLAG_MASK != 0
        frames.append(
            FrameInput(
                epoch_id=f"sat-{i}",
                mjd=60000 + i * 10,
                image=img,
                variance=var,
                flags=flags,
                wavelength_um=1.0,
                x_pix=cx,
                y_pix=cy,
            )
        )
    scores = score_frames(
        frames,
        metric="brightness_snr",
        reference="median_others",
        aperture_pix=1.5,
        allow_saturated_approx=True,
    )
    ok = [s for s in scores if s.status == "ok"]
    assert ok, "expected approximate scores from ring/relaxed path"
    assert all(s.approximate for s in ok)
    assert all("saturated" in (s.approximate_reason or "").lower() for s in ok)
    assert all(s.score is not None and s.score_err is not None for s in ok)

    # Seeded wing mover still ranks high under approximate ring photometry
    mover = _mover_frames(n=6, inject_at=(4, 5), step_pix=0.8)
    for fr in mover:
        flags = np.zeros(fr.image.shape, dtype=np.int64)
        yy, xx = np.indices(fr.image.shape)
        # Saturate the whole default aperture so photometry must use the ring
        core = (xx - fr.x_pix) ** 2 + (yy - fr.y_pix) ** 2 <= 1.6**2
        flags[core] = (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["BLOOM"])
        fr.flags = flags
    m_scores = score_frames(
        mover,
        metric="brightness_snr",
        reference="median_others",
        aperture_pix=1.5,
        allow_saturated_approx=True,
        is_synthetic=True,
    )
    assert any(s.approximate and s.status == "ok" for s in m_scores)
    static_abs = [abs(s.score or 0) for s in m_scores if int(s.epoch_id.split("-")[1]) < 4 and s.score is not None]
    inject_abs = [abs(s.score or 0) for s in m_scores if int(s.epoch_id.split("-")[1]) >= 4 and s.score is not None]
    assert static_abs and inject_abs
    assert np.mean(inject_abs) > np.mean(static_abs)


def test_bug7_centroid_window_grows_with_expected_hop():
    assert centroid_window_half_pix(0.5) == 2.0  # floor
    assert centroid_window_half_pix(3.0) == 4.5  # hop + psf


def test_bug7_motion_windowed_centroid_finds_offset_star():
    shape = (48, 48)
    img, _ = _gauss_star(shape, 28.0, 22.0, amp=80.0, sigma=1.3, bg=5.0, noise=0.0)
    cx, cy, ex, ey, half = motion_windowed_centroid(
        img, None, x_pred=24.0, y_pred=24.0, expected_shift_pix=4.0
    )
    assert cx is not None and cy is not None
    assert half >= 4.0
    assert abs(cx - 28.0) < 1.0
    assert abs(cy - 22.0) < 1.0
    assert ex is not None and ey is not None


def test_bug7_score_frames_uses_motion_window_note():
    """score_frames default path notes the PM window half-width."""
    shape = (32, 32)
    frames = []
    for i in range(4):
        img, var = _gauss_star(shape, 16.0 + 0.3 * i, 16.0, amp=40.0, noise=0.0)
        frames.append(
            FrameInput(
                epoch_id=f"m-{i}",
                mjd=60000.0 + i * 30,
                image=img,
                variance=var,
                wavelength_um=1.0,
                x_pix=16.0 + 0.3 * i,
                y_pix=16.0,
                expected_shift_pix=1.5,
            )
        )
    scores = score_frames(
        frames,
        metric="position_shift",
        reference="first_epoch",
        use_motion_window=True,
    )
    assert any("centroid_window_half_pix=" in n for s in scores for n in s.notes)
    assert any(s.centroid_x is not None for s in scores)


def test_fully_masked_frame_reports_source_saturated():
    """Bug 2: entire frame bad-flagged → not computed with saturated reason."""
    from app.adapters.spherex import FLAG_BITS

    shape = (16, 16)
    flags = np.full(shape, (1 << FLAG_BITS["OVERFLOW"]) | (1 << FLAG_BITS["NONFUNC"]), dtype=np.int64)
    frames = []
    for i in range(3):
        frames.append(
            FrameInput(
                epoch_id=f"dead-{i}",
                mjd=1.0 + i,
                image=np.ones(shape) * (10 + i),
                variance=np.ones(shape),
                flags=flags,
                wavelength_um=1.0,
                x_pix=8,
                y_pix=8,
            )
        )
    scores = score_frames(
        frames,
        metric="brightness_snr",
        reference="median_others",
        allow_saturated_approx=True,
    )
    for s in scores:
        assert s.status == "not_computed"
        assert s.score is None
        assert "saturated" in s.status_reason.lower()
        assert s.n_masked == s.n_aperture_pixels
