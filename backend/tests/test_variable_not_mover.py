"""Phase 4: variables must not inflate known-mover recovery."""

from __future__ import annotations

import json
from pathlib import Path

from app.pm_table import clear_pm_table_cache, find_target_row, is_variable_control, row_to_pm_dict


def test_pm_table_marks_variables():
    clear_pm_table_cache()
    for tid in ("rw_aurigae", "r_draconis"):
        row = find_target_row(tid)
        assert row is not None
        assert is_variable_control(row)
        pm = row_to_pm_dict(row)
        assert pm["is_variable_control"] is True
        assert pm["is_high_pm_mover"] is False
        assert "variable" in (pm["classification_note"] or "").lower()


def test_pm_table_high_pm_movers_not_variable():
    clear_pm_table_cache()
    for tid in ("wise0855", "barnards_star", "epsilon_indi_b"):
        row = find_target_row(tid)
        assert row is not None
        assert not is_variable_control(row)
        pm = row_to_pm_dict(row)
        assert pm["is_variable_control"] is False
        assert pm["is_high_pm_mover"] is True


def test_scoreboard_excludes_variables_from_mover_recovery():
    path = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "public"
        / "demo-data"
        / "scoreboard.json"
    )
    assert path.exists(), "run pipeline/run_validation.py first"
    sb = json.loads(path.read_text(encoding="utf-8"))
    field = sb["field_validation"]
    assert field["status"] == "measured"
    # Only high-PM movers in the recovery denominator
    roles = {t["target_id"]: t.get("role") for t in field["per_target"]}
    assert roles.get("rw_aurigae") == "variable_control"
    assert roles.get("r_draconis") == "variable_control"
    assert roles.get("wise0855") == "known_mover"
    assert roles.get("barnards_star") == "known_mover"
    assert roles.get("epsilon_indi_b") == "known_mover"
    # Aggregate must not count variables as recovered/missed movers
    n_known = field["n_known"]
    assert n_known == 3  # wise + barnards + epsilon
    assert field["n_recovered"] + field["n_missed"] == n_known
    vc = field["variable_controls"]
    assert vc["n_targets"] == 2
    ids = {p["target_id"] for p in vc["per_target"]}
    assert ids == {"rw_aurigae", "r_draconis"}
