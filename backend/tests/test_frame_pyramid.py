"""Unit tests for full-frame pyramid tile math."""

from __future__ import annotations

import numpy as np

from app.frame_pyramid import (
    TILE_SIZE,
    block_mean_downsample,
    block_or_downsample,
    extract_tile,
    is_full_detector_shape,
    level_shape,
    num_levels,
    robust_stats,
    tile_grid,
    tile_slice,
    write_pyramid,
    read_image_tile,
    read_flags_tile,
    PyramidMeta,
    pyramid_ready,
)


def test_level_shape_powers_of_two():
    assert level_shape(2040, 2040, 0) == (2040, 2040)
    assert level_shape(2040, 2040, 1) == (1020, 1020)
    assert level_shape(2040, 2040, 3) == (255, 255)


def test_num_levels_covers_frame():
    n = num_levels(2040, 2040, tile=TILE_SIZE, max_level=3)
    assert n == 4  # 0..3
    h, w = level_shape(2040, 2040, n - 1)
    assert h <= TILE_SIZE and w <= TILE_SIZE


def test_tile_grid_and_slice():
    nty, ntx = tile_grid(500, 500, tile=256)
    assert (nty, ntx) == (2, 2)
    ys, xs = tile_slice(500, 500, 1, 1, tile=256)
    assert ys == slice(256, 500)
    assert xs == slice(256, 500)


def test_block_mean_preserves_nan_blocks():
    img = np.arange(16, dtype=np.float64).reshape(4, 4)
    img[0, 0] = np.nan
    out = block_mean_downsample(img, 2)
    assert out.shape == (2, 2)
    # Top-left block has one NaN → nanmean of 3 values
    expected = np.nanmean([np.nan, 1, 4, 5])
    assert np.isclose(out[0, 0], expected, equal_nan=False)


def test_block_or_flags():
    flags = np.zeros((4, 4), dtype=np.int32)
    flags[0, 0] = 1
    flags[1, 1] = 4
    flags[2, 3] = 8
    out = block_or_downsample(flags, 2)
    assert out.shape == (2, 2)
    assert int(out[0, 0]) == (1 | 4)
    assert int(out[1, 1]) == 8


def test_extract_edge_tile_smaller():
    arr = np.zeros((300, 300), dtype=np.float32)
    tile = extract_tile(arr, 1, 1, tile=256)
    assert tile.shape == (44, 44)


def test_robust_stats_finite():
    rng = np.random.default_rng(0)
    img = rng.normal(10.0, 2.0, size=(100, 100))
    img[0, 0] = np.nan
    s = robust_stats(img)
    assert s["p01"] < s["p50"] < s["p995"]
    assert np.isfinite(s["z1"]) and np.isfinite(s["z2"])


def test_is_full_detector_shape():
    assert is_full_detector_shape(2040, 2040)
    assert not is_full_detector_shape(293, 293)


def test_write_and_read_pyramid(tmp_path):
    ny, nx = 2040, 2040
    image = np.linspace(0, 1, ny * nx, dtype=np.float32).reshape(ny, nx)
    image[10, 10] = np.nan
    flags = np.zeros((ny, nx), dtype=np.int32)
    flags[10, 10] = 1 << 21
    meta = PyramidMeta(
        obs_id="test_obs",
        detector=5,
        shape=(ny, nx),
        tile_size=TILE_SIZE,
        n_levels=num_levels(ny, nx),
        subtract_zodi=False,
        bunit="MJy/sr",
        source_url="https://example.test/full.fits",
        mjd=60000.0,
        time_iso="2025-01-01T00:00:00",
        bandpass="SPHEREx-D5",
        wcs_header={"NAXIS": 2},
        stats=robust_stats(image),
    )
    write_pyramid(
        tmp_path,
        obs_id="test_obs",
        detector=5,
        image=image,
        flags=flags,
        subtract_zodi=False,
        meta=meta,
    )
    assert pyramid_ready(tmp_path, "test_obs", 5, subtract_zodi=False)
    raw = read_image_tile(tmp_path, "test_obs", 5, 0, 0, 0, subtract_zodi=False)
    arr = np.frombuffer(raw, dtype="<f4")
    assert arr.size == TILE_SIZE * TILE_SIZE
    assert np.isnan(arr.reshape(TILE_SIZE, TILE_SIZE)[10, 10])
    fl = read_flags_tile(tmp_path, "test_obs", 5, 0, 0, 0, subtract_zodi=False)
    fl_arr = np.frombuffer(fl, dtype="<i4").reshape(TILE_SIZE, TILE_SIZE)
    assert int(fl_arr[10, 10]) == (1 << 21)


def test_pyramid_ready_rejects_cutout_sized(tmp_path):
    ny, nx = 293, 293
    image = np.zeros((ny, nx), dtype=np.float32)
    flags = np.zeros((ny, nx), dtype=np.int32)
    meta = PyramidMeta(
        obs_id="crop_obs",
        detector=5,
        shape=(ny, nx),
        tile_size=TILE_SIZE,
        n_levels=num_levels(ny, nx),
        subtract_zodi=False,
        bunit="MJy/sr",
        source_url="https://example.test/crop.fits",
        mjd=60000.0,
        time_iso="2025-01-01T00:00:00",
        bandpass="SPHEREx-D5",
        wcs_header={"NAXIS": 2},
        stats=robust_stats(image),
    )
    write_pyramid(
        tmp_path,
        obs_id="crop_obs",
        detector=5,
        image=image,
        flags=flags,
        subtract_zodi=False,
        meta=meta,
    )
    assert not pyramid_ready(tmp_path, "crop_obs", 5, subtract_zodi=False)
