"""Bug 3: WISE 0855 demo default must be a mid-IR detector, not D1."""

from __future__ import annotations

import json
from pathlib import Path

from app.main import DEFAULT_DETECTOR_BY_TARGET

ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / "frontend" / "public" / "demo-data"


def test_default_detector_prefers_d5_for_wise0855():
    assert DEFAULT_DETECTOR_BY_TARGET["wise0855"] == "SPHEREx-D5"


def test_cached_manifest_is_d5_not_d1():
    man = json.loads((DEMO / "wise0855" / "manifest.json").read_text(encoding="utf-8"))
    assert man["bandpass"] == "SPHEREx-D5"
    assert len(man["frames"]) >= 6
    assert all(int(f.get("detector", 0)) == 5 for f in man["frames"])
    waves = [f.get("central_wavelength_um") for f in man["frames"] if f.get("central_wavelength_um")]
    assert waves
    assert min(waves) >= 3.5  # D5 band ~3.83–4.41 µm (Data Products)
    assert max(waves) <= 4.6


def test_visibility_report_compares_d5_d6_d1():
    vis = json.loads((DEMO / "visibility_report.json").read_text(encoding="utf-8"))
    row = next(r for r in vis if r["target_id"] == "wise0855")
    assert row["bandpass_cached"] == "SPHEREx-D5"
    assert row["detectable_in_cached_cutouts"] is True
    assert row["median_peak_sn"] is not None and row["median_peak_sn"] >= 3.0
    bands = {a["bandpass"] for a in row["detector_attempts"]}
    assert "SPHEREx-D5" in bands
    assert "SPHEREx-D6" in bands
    assert "SPHEREx-D1" in bands
    d5 = next(a for a in row["detector_attempts"] if a["bandpass"] == "SPHEREx-D5")
    assert d5["ok"] is True
    assert d5["detectable"] is True
