"""Server-side validation for community observation reports."""

from __future__ import annotations

import re
from typing import Optional

from .sanitize import looks_like_spam, sanitize_text
from .schema import (
    MAX_DESCRIPTION_CHARS,
    MAX_FRAMES,
    MAX_HIGHLIGHT_FRAC,
    MIN_FRAMES,
    ObservationCreate,
    FieldError,
    ValidationResult,
)
from .wordcount import MAX_WORDS, count_words

MIN_FORM_MS = 1500  # soft anti-bot; flag/reject empty-speed spam
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_observation(
    payload: ObservationCreate,
    *,
    known_epoch_ids: Optional[set[str]] = None,
) -> ValidationResult:
    errors: list[FieldError] = []
    warnings: list[str] = []
    needs_review = False

    # Honeypot
    if payload.honeypot and payload.honeypot.strip():
        errors.append(FieldError(field="honeypot", message="Rejected."))
        return ValidationResult(ok=False, errors=errors, word_count=0)

    # Timing
    if payload.form_ms < MIN_FORM_MS:
        errors.append(
            FieldError(
                field="form_ms",
                message=f"Form submitted too quickly (min {MIN_FORM_MS} ms).",
            )
        )

    # Description / word count
    desc = sanitize_text(payload.description, max_len=MAX_DESCRIPTION_CHARS + 100)
    wc = count_words(desc)
    if len(desc) > MAX_DESCRIPTION_CHARS:
        errors.append(
            FieldError(
                field="description",
                message=f"Description exceeds {MAX_DESCRIPTION_CHARS} characters.",
            )
        )
    if wc > MAX_WORDS:
        errors.append(
            FieldError(
                field="description",
                message=(
                    f"Description exceeds {MAX_WORDS} words "
                    f"(got {wc}). Shorten the text; it will not be truncated."
                ),
            )
        )
    if looks_like_spam(desc):
        needs_review = True
        warnings.append("Spam heuristic matched — flagged needs_review, not deleted.")

    # Frames
    n = len(payload.frames)
    if n < MIN_FRAMES:
        errors.append(
            FieldError(
                field="frames",
                message=f"Select at least {MIN_FRAMES} frames (a mover needs ≥2 epochs).",
            )
        )
    if n > MAX_FRAMES:
        errors.append(
            FieldError(
                field="frames",
                message=f"At most {MAX_FRAMES} frames per report (got {n}).",
            )
        )

    epoch_ids = [f.epoch_id for f in payload.frames]
    if len(set(epoch_ids)) != len(epoch_ids):
        errors.append(FieldError(field="frames", message="Duplicate epoch_id in selection."))

    allowed = set(payload.allowed_epoch_ids) if payload.allowed_epoch_ids else None
    if known_epoch_ids is not None:
        allowed = set(known_epoch_ids) if allowed is None else (allowed & set(known_epoch_ids))

    if allowed is not None:
        for f in payload.frames:
            if f.epoch_id not in allowed:
                errors.append(
                    FieldError(
                        field="frames",
                        message=f"Unknown or unauthorized frame id: {f.epoch_id!r}",
                    )
                )

    # Highlights: one per selected frame
    hl_by_id = {h.epoch_id: h for h in payload.highlights}
    if len(hl_by_id) != len(payload.highlights):
        errors.append(FieldError(field="highlights", message="Duplicate highlight epoch_id."))

    for f in payload.frames:
        h = hl_by_id.get(f.epoch_id)
        if h is None:
            errors.append(
                FieldError(
                    field="highlights",
                    message=f"Missing highlight for frame {f.epoch_id}",
                )
            )
            continue
        rect = h.pixel.normalized()
        if rect.width() <= 0 or rect.height() <= 0:
            errors.append(
                FieldError(
                    field="highlights",
                    message=f"Zero-size highlight on {f.epoch_id}",
                )
            )
            continue
        shape = f.image_shape
        if len(shape) >= 2:
            ny, nx = int(shape[0]), int(shape[1])
            if (
                rect.x0 < -0.5
                or rect.y0 < -0.5
                or rect.x1 > nx + 0.5
                or rect.y1 > ny + 0.5
            ):
                errors.append(
                    FieldError(
                        field="highlights",
                        message=f"Highlight outside image bounds on {f.epoch_id}",
                    )
                )
            img_area = float(nx * ny)
            if img_area > 0 and rect.area() > MAX_HIGHLIGHT_FRAC * img_area:
                errors.append(
                    FieldError(
                        field="highlights",
                        message=(
                            f"Highlight on {f.epoch_id} covers more than "
                            f"{int(MAX_HIGHLIGHT_FRAC * 100)}% of the frame."
                        ),
                    )
                )
        if h.sky_corners and len(h.sky_corners) not in (0, 4):
            warnings.append(f"{f.epoch_id}: prefer 4 RA/Dec corners for sky polygon.")

    # Direction required (enum always present via pydantic)
    try:
        _ = payload.answers.direction
    except Exception:
        errors.append(FieldError(field="answers.direction", message="Direction is required."))

    # Contact email
    if payload.contact_email:
        if not payload.contact_consent:
            errors.append(
                FieldError(
                    field="contact_consent",
                    message="Consent required to store an optional contact email.",
                )
            )
        email = payload.contact_email.strip()
        if not EMAIL_RE.match(email) or len(email) > 254:
            errors.append(FieldError(field="contact_email", message="Invalid email format."))

    # Context
    if not (-90 <= payload.context.dec <= 90):
        errors.append(FieldError(field="context.dec", message="Dec out of range."))
    if not (0 <= payload.context.ra < 360 or -180 <= payload.context.ra <= 180):
        # Allow either convention but flag extremes
        if abs(payload.context.ra) > 360:
            errors.append(FieldError(field="context.ra", message="RA out of range."))

    # Idempotency key charset
    if not re.match(r"^[A-Za-z0-9._:-]{8,128}$", payload.idempotency_key):
        errors.append(
            FieldError(
                field="idempotency_key",
                message="Idempotency key must be 8–128 URL-safe characters.",
            )
        )

    if any(f.is_synthetic for f in payload.frames) or payload.is_synthetic_flag:
        warnings.append("Report marked with synthetic/SIMULATED content.")

    return ValidationResult(
        ok=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        word_count=wc,
        needs_review=needs_review,
    )
