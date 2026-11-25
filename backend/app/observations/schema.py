"""
Observation report schema (schema_versioned).

Community observations only — never discoveries.
SPHEREx frame ID field names follow what SkyFlip already exposes
(obs_id, epoch_id, detector, bandpass, MJD). Filename-style IMGxxxxxxxx
identifiers: TODO(VERIFY) against Explanatory Supplement / IRSA product naming
before exposing as a separate required field.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

SCHEMA_VERSION = 1
MIN_FRAMES = 2
MAX_FRAMES = 200
MAX_HIGHLIGHT_FRAC = 0.5  # max rectangle area / image area
DEFAULT_MAX_SUBMISSION_BYTES = 20 * 1024 * 1024
MAX_DESCRIPTION_CHARS = 12_000  # defense in depth alongside word limit


class ObjectGuess(str, Enum):
    not_sure = "not_sure"
    sso = "asteroid_sso"
    high_pm = "nearby_high_pm"
    variable = "variable_or_brightness"
    artifact = "image_artifact"
    cosmic_ray = "cosmic_ray"
    other = "other"
    simulated = "simulated_injection"  # user says this is a known SIMULATED object


class DirectionGuess(str, Enum):
    up = "up"
    down = "down"
    left = "left"
    right = "right"
    up_left = "up_left"
    up_right = "up_right"
    down_left = "down_left"
    down_right = "down_right"
    brightness_only = "brightness_only"
    not_sure = "not_sure"


class EaseSeen(str, Enum):
    obvious = "obvious"
    subtle = "subtle"
    after_zoom = "after_zoom"


class SubmissionStatus(str, Enum):
    new = "new"
    reviewed = "reviewed"
    duplicate = "duplicate"
    rejected = "rejected"
    needs_review = "needs_review"


class PixelRect(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float

    def width(self) -> float:
        return abs(self.x1 - self.x0)

    def height(self) -> float:
        return abs(self.y1 - self.y0)

    def area(self) -> float:
        return self.width() * self.height()

    def normalized(self) -> "PixelRect":
        return PixelRect(
            x0=min(self.x0, self.x1),
            y0=min(self.y0, self.y1),
            x1=max(self.x0, self.x1),
            y1=max(self.y0, self.y1),
        )


class SkyCorner(BaseModel):
    ra: float
    dec: float


class FrameHighlight(BaseModel):
    epoch_id: str
    mode: Literal["default", "custom"] = "default"
    pixel: PixelRect
    sky_corners: list[SkyCorner] = Field(default_factory=list)  # 4 corners preferred


class FrameRef(BaseModel):
    """Archive / SkyFlip identifiers for one selected frame."""

    epoch_id: str
    obs_id: str = ""
    mjd: float
    time_iso: str = ""
    detector: Optional[int] = None
    bandpass: str = ""
    central_wavelength_um: Optional[float] = None
    collection: str = ""
    pixel_scale_arcsec: float = 6.15
    image_shape: list[int] = Field(default_factory=list)  # [ny, nx]
    bunit: str = "MJy/sr"
    wcs: dict[str, Any] = Field(default_factory=dict)
    cutout_url: Optional[str] = None
    content_hash: Optional[str] = None
    # TODO(VERIFY): SPHEREx product filename / IMGxxxxxxxx-style id if distinct from obs_id
    product_filename: Optional[str] = None
    is_synthetic: bool = False


class DisplaySettings(BaseModel):
    """Reproduce the user's view (share URL + explicit fields)."""

    share_url: str = ""
    detector: Optional[int] = None
    stretch: Optional[str] = None
    stretch_limits: Optional[list[float]] = None
    invert: bool = False
    interpolation: bool = False
    zoom_region: Optional[dict[str, float]] = None
    targeting_mode: Optional[str] = None
    median_subtract: bool = False
    difference_mode: Optional[str] = None
    change_slider: Optional[dict[str, Any]] = None
    blink_hz: Optional[float] = None
    wavelength_tol_um: Optional[float] = None
    overlays: Optional[dict[str, bool]] = None
    north_east_orientation: Optional[dict[str, Any]] = None
    device_pixel_ratio: Optional[float] = None
    viewport: Optional[dict[str, float]] = None
    user_agent_coarse: Optional[str] = None  # coarse only; no fingerprinting extras


class ObservationAnswers(BaseModel):
    object_guess: ObjectGuess = ObjectGuess.not_sure
    object_guess_other: str = ""
    direction: DirectionGuess  # required (not_sure allowed)
    confidence: int = Field(ge=1, le=5)
    ease: Optional[EaseSeen] = None
    computed_direction_pa_deg: Optional[float] = None
    computed_direction_label: Optional[str] = None

    @field_validator("confidence")
    @classmethod
    def _conf(cls, v: int) -> int:
        if v < 1 or v > 5:
            raise ValueError("confidence must be 1–5")
        return v


class ObservationContext(BaseModel):
    batch_id: Optional[str] = None
    image_mode: Optional[Literal["full_frame", "target_crop"]] = None
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    ra: float = Field(ge=0, lt=360, allow_inf_nan=False)
    dec: float = Field(ge=-90, le=90, allow_inf_nan=False)
    ra_dec_source: str = "unknown"  # coordinate_entry | target_button | click | url
    fov_deg: Optional[float] = None
    data_source: str = "unknown"  # live | cached-demo
    data_release: Optional[str] = None  # TODO(VERIFY) when IRSA exposes a release string
    processing_version: Optional[str] = None  # TODO(VERIFY) VERSION header


class ObservationCreate(BaseModel):
    """Client payload for POST /api/observations (JSON body; files separate)."""

    schema_version: int = SCHEMA_VERSION
    idempotency_key: str = Field(min_length=8, max_length=128)
    description: str = ""
    context: ObservationContext
    frames: list[FrameRef]
    highlights: list[FrameHighlight]
    answers: ObservationAnswers
    display: DisplaySettings = Field(default_factory=DisplaySettings)
    is_synthetic_flag: bool = False  # client or server may set if synthetic frames present
    # Abuse / UX
    honeypot: str = ""  # must be empty
    form_ms: int = 0  # time spent on form; server enforces minimum
    contact_email: Optional[str] = None
    contact_consent: bool = False
    # Allowed frame IDs from frozen context (server checks membership)
    allowed_epoch_ids: list[str] = Field(default_factory=list)


class FieldError(BaseModel):
    field: str
    message: str


class ValidationResult(BaseModel):
    ok: bool
    errors: list[FieldError] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    word_count: int = 0
    needs_review: bool = False
