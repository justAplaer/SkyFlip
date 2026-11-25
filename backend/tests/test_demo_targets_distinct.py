"""Each demo target must have its own obs_id list and in-frame target pixels."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

DEMO = Path(__file__).resolve().parents[2] / "frontend" / "public" / "demo-data"
TARGETS = [
    "barnards_star",
    "epsilon_indi_b",
    "wise0855",
    "rw_aurigae",
    "r_draconis",
]


def _manifest(tid: str) -> dict:
    path = DEMO / tid / "manifest.json"
    assert path.is_file(), f"missing {path}"
    return json.loads(path.read_text())


def test_five_targets_have_distinct_obs_id_lists():
    lists = {}
    for tid in TARGETS:
        man = _manifest(tid)
        obs = [str(f["obs_id"]) for f in man["frames"]]
        assert len(obs) >= 5, f"{tid} has only {len(obs)} frames"
        assert len(set(obs)) == len(obs), f"{tid} has duplicate obs_ids"
        lists[tid] = tuple(obs)

    for a in TARGETS:
        for b in TARGETS:
            if a >= b:
                continue
            assert lists[a] != lists[b], f"{a} and {b} share the same obs_id list"
            # Also fail if they share any obs_id at all
            overlap = set(lists[a]) & set(lists[b])
            assert not overlap, f"{a} and {b} share obs_ids: {sorted(overlap)}"


def test_each_epoch_target_pixel_inside_frame():
    for tid in TARGETS:
        man = _manifest(tid)
        for f in man["frames"]:
            shape = f.get("float_shape") or f.get("image_shape")
            assert shape and len(shape) == 2, f"{tid} {f.get('obs_id')}: no shape"
            ny, nx = int(shape[0]), int(shape[1])
            x = f.get("predicted_x_pix", f.get("target_x_pix"))
            y = f.get("predicted_y_pix", f.get("target_y_pix"))
            assert x is not None and y is not None, f"{tid} {f['obs_id']}: no target xy"
            # Margin ≥ 0 (crop packs center ~58); stay inside array
            assert 0 <= float(x) < nx, f"{tid} {f['obs_id']}: x={x} outside 0..{nx}"
            assert 0 <= float(y) < ny, f"{tid} {f['obs_id']}: y={y} outside 0..{ny}"
            # Prefer ≥2 px from edge when crop is large enough
            if nx >= 20 and ny >= 20:
                assert 2 <= float(x) < nx - 2
                assert 2 <= float(y) < ny - 2


def test_frames_ordered_by_mjd():
    for tid in TARGETS:
        mjds = [float(f["mjd"]) for f in _manifest(tid)["frames"]]
        assert mjds == sorted(mjds), f"{tid} frames not time-ordered"


def test_print_summary_table(capsys):
    """Print the acceptance table (always passes)."""
    rows = []
    for tid in TARGETS:
        man = _manifest(tid)
        for f in man["frames"]:
            rows.append(
                (
                    tid,
                    f.get("obs_id"),
                    f.get("detector"),
                    f.get("mjd"),
                    f.get("predicted_x_pix"),
                    f.get("predicted_y_pix"),
                    f.get("peak_sn_at_predicted"),
                )
            )
    print("\ntarget | obs_id | det | mjd | x | y | peak_sn")
    for r in rows:
        print(" | ".join("" if v is None else str(v) for v in r))
    assert len(rows) >= 5 * 5
