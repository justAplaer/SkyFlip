"""Aggregation groups nearby seeded synthetic reports."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.observations.db import connect, insert_submission, migrate
from app.observations.schema import (
    DirectionGuess,
    FrameHighlight,
    FrameRef,
    ObservationAnswers,
    ObservationContext,
    ObservationCreate,
    PixelRect,
)
from app.observations.service import aggregate_by_sky


@pytest.fixture()
def db(tmp_path: Path, monkeypatch):
    path = tmp_path / "agg.sqlite3"
    monkeypatch.setenv("SKYFLIP_OBSERVATIONS_DB", str(path))
    conn = connect(path)
    migrate(conn)
    yield conn
    conn.close()


def _p(key: str, ra: float, dec: float) -> ObservationCreate:
    return ObservationCreate(
        idempotency_key=key,
        description="Seeded synthetic community report near a test sky patch.",
        context=ObservationContext(ra=ra, dec=dec, target_id="wise0855"),
        frames=[
            FrameRef(epoch_id="a", obs_id="A", mjd=1.0, image_shape=[29, 29], is_synthetic=True),
            FrameRef(epoch_id="b", obs_id="B", mjd=2.0, image_shape=[29, 29], is_synthetic=True),
        ],
        highlights=[
            FrameHighlight(epoch_id="a", pixel=PixelRect(x0=1, y0=1, x1=4, y1=4)),
            FrameHighlight(epoch_id="b", pixel=PixelRect(x0=2, y0=2, x1=5, y1=5)),
        ],
        answers=ObservationAnswers(direction=DirectionGuess.up, confidence=4),
        form_ms=5000,
        allowed_epoch_ids=["a", "b"],
        is_synthetic_flag=True,
    )


def test_aggregate_groups_nearby(db, monkeypatch, tmp_path):
    monkeypatch.setenv("SKYFLIP_OBSERVATIONS_DB", str(tmp_path / "agg.sqlite3"))
    insert_submission(db, _p("agg-a1aaaaaa", 133.795, -7.245))
    insert_submission(db, _p("agg-a2aaaaaa", 133.7951, -7.24505))
    insert_submission(db, _p("agg-faraway1", 10.0, 20.0))
    groups = aggregate_by_sky(cone_arcsec=30, min_reports=2)
    assert groups
    assert groups[0]["n_reports"] >= 2
    assert "not a detection" in groups[0]["label"]
    assert groups[0]["has_synthetic"] is True
