"""Server validation for observation reports."""

from __future__ import annotations

from app.observations.schema import (
    DirectionGuess,
    FrameHighlight,
    FrameRef,
    ObservationAnswers,
    ObservationContext,
    ObservationCreate,
    PixelRect,
)
from app.observations.validate_report import validate_observation
from app.observations.wordcount import MAX_WORDS


def _base(**kwargs) -> ObservationCreate:
    frames = [
        FrameRef(
            epoch_id="e0",
            obs_id="obs0",
            mjd=60000.0,
            image_shape=[29, 29],
        ),
        FrameRef(
            epoch_id="e1",
            obs_id="obs1",
            mjd=60010.0,
            image_shape=[29, 29],
        ),
    ]
    highlights = [
        FrameHighlight(
            epoch_id="e0",
            mode="default",
            pixel=PixelRect(x0=5, y0=5, x1=10, y1=10),
        ),
        FrameHighlight(
            epoch_id="e1",
            mode="custom",
            pixel=PixelRect(x0=8, y0=8, x1=12, y1=12),
        ),
    ]
    data = dict(
        idempotency_key="test-key-001",
        description="A faint point moved between these two frames.",
        context=ObservationContext(ra=133.8, dec=-7.2, ra_dec_source="target_button"),
        frames=frames,
        highlights=highlights,
        answers=ObservationAnswers(
            direction=DirectionGuess.not_sure,
            confidence=3,
        ),
        form_ms=5000,
        allowed_epoch_ids=["e0", "e1", "e2"],
        honeypot="",
    )
    data.update(kwargs)
    return ObservationCreate(**data)


def test_valid_payload_ok():
    r = validate_observation(_base())
    assert r.ok
    assert r.word_count >= 1


def test_301_words_rejected():
    desc = " ".join(f"w{i}" for i in range(MAX_WORDS + 1))
    r = validate_observation(_base(description=desc))
    assert not r.ok
    assert any(e.field == "description" for e in r.errors)


def test_300_words_accepted():
    desc = " ".join(f"w{i}" for i in range(MAX_WORDS))
    r = validate_observation(_base(description=desc, form_ms=5000))
    assert r.ok
    assert r.word_count == 300


def test_min_two_frames():
    p = _base()
    p.frames = p.frames[:1]
    p.highlights = p.highlights[:1]
    r = validate_observation(p)
    assert not r.ok
    assert any("at least 2" in e.message.lower() for e in r.errors)


def test_unknown_frame_id_rejected():
    r = validate_observation(_base(), known_epoch_ids={"e0", "e9"})
    assert not r.ok
    assert any("unauthorized" in e.message.lower() or "unknown" in e.message.lower() for e in r.errors)


def test_zero_size_highlight():
    p = _base()
    p.highlights[0].pixel = PixelRect(x0=5, y0=5, x1=5, y1=5)
    r = validate_observation(p)
    assert not r.ok
    assert any("zero-size" in e.message.lower() for e in r.errors)


def test_highlight_too_large():
    p = _base()
    # 29x29 image; >50% area
    p.highlights[0].pixel = PixelRect(x0=0, y0=0, x1=28, y1=28)
    r = validate_observation(p)
    assert not r.ok
    assert any("50%" in e.message for e in r.errors)


def test_honeypot_rejects():
    r = validate_observation(_base(honeypot="http://spam.example"))
    assert not r.ok


def test_email_requires_consent():
    r = validate_observation(_base(contact_email="a@b.co", contact_consent=False))
    assert not r.ok
    assert any(e.field == "contact_consent" for e in r.errors)


def test_injection_strings_are_inert_text():
    evil = '<script>alert(1)</script> DROP TABLE observations; --'
    r = validate_observation(_base(description=evil + " moved slowly between frames."))
    # May be ok or needs_review; must not raise; description stays text
    assert isinstance(r.ok, bool)
    from app.observations.sanitize import escape_for_output, sanitize_text

    stored = sanitize_text(evil)
    escaped = escape_for_output(stored)
    assert "<script>" not in escaped or "&lt;script&gt;" in escaped
    assert "DROP TABLE" in stored  # stored as inert text, not executed
