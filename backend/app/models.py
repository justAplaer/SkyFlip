"""Pydantic API contract for SkyFlip."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class DataSource(str, Enum):
    live = "live"
    cached_demo = "cached-demo"


class HealthServiceStatus(BaseModel):
    ok: bool
    detail: Optional[str] = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded", "down"]
    source: DataSource = DataSource.live
    services: dict[str, HealthServiceStatus]
    demo_cache_available: bool = False
    pixel_scale_arcsec: float = 6.15


class ResolveResponse(BaseModel):
    name: str
    ra: float
    dec: float
    source: DataSource = DataSource.live
    catalog: str = "SIMBAD"
    uncertainty_arcsec: Optional[float] = None
    uncertainty_note: str = "SIMBAD coordinates; no separate uncertainty provided by resolver"


class EpochInfo(BaseModel):
    epoch_id: str
    obs_id: str
    mjd: float
    time_iso: str
    bandpass: str
    detector: int
    collection: str = ""
    cutout_url: Optional[str] = None
    central_wavelength_um: Optional[float] = None
    bandwidth_um: Optional[float] = None
    flag_summary: dict[str, int] = Field(default_factory=dict)
    quality_notes: list[str] = Field(default_factory=list)
    s_pixel_scale_arcsec: Optional[float] = 6.15


class EpochsResponse(BaseModel):
    ra: float
    dec: float
    fov_deg: float
    epochs: list[EpochInfo]
    source: DataSource = DataSource.live
    note: str = (
        "SPHEREx LVF means wavelength varies across the detector; "
        "prefer matching detector/nearby wavelength when blinking."
    )


class CutoutFrameMeta(BaseModel):
    collection: str = ""
    epoch_id: str
    obs_id: str
    mjd: float
    time_iso: str
    bandpass: str
    detector: int
    image_url: str
    stretch_hint: dict[str, float] = Field(default_factory=dict)
    central_wavelength_um: Optional[float] = None
    flag_summary: dict[str, int] = Field(default_factory=dict)
    wcs: dict[str, Any] = Field(default_factory=dict)
    bunit: str = "MJy/sr"
    is_synthetic: bool = False
    # Full-frame / tiled viewer fields (optional — cutout mode leaves these empty).
    source_url: Optional[str] = None
    array_shape: Optional[list[int]] = None
    target_x_pix: Optional[float] = None
    target_y_pix: Optional[float] = None
    subtract_zodi: bool = False
    view_mode: Literal["full_frame", "target_crop", "overview"] = "target_crop"
    frame_meta_url: Optional[str] = None


class CutoutsResponse(BaseModel):
    ra: float
    dec: float
    fov_deg: float
    stack: Literal["none", "detector", "all_detectors", "date"] = "none"
    frames: list[CutoutFrameMeta]
    source: DataSource = DataSource.live
    pixel_scale_arcsec: float = 6.15
    subtract_zodi: bool = False
    view_mode: Literal["full_frame", "target_crop", "overview"] = "target_crop"
    note: Optional[str] = (
        "IMAGE is surface brightness in MJy/sr; ZODI is not subtracted in Level-2 IMAGE."
    )


class FramePyramidMeta(BaseModel):
    obs_id: str
    detector: int
    shape: list[int]
    naxis1: int
    naxis2: int
    tile_size: int
    n_levels: int
    subtract_zodi: bool
    bunit: str = "MJy/sr"
    source_url: str
    mjd: float
    time_iso: str = ""
    bandpass: str = ""
    wcs: dict[str, Any] = Field(default_factory=dict)
    stats: dict[str, float] = Field(default_factory=dict)
    central_wavelength_um: Optional[float] = None
    bandwidth_um: Optional[float] = None
    collection: str = ""
    cache_key: str = ""
    units: str = "MJy/sr"
    target_x_pix: Optional[float] = None
    target_y_pix: Optional[float] = None


class FullEpochFrame(BaseModel):
    epoch_id: str
    obs_id: str
    detector: int
    mjd: float
    time_iso: str = ""
    bandpass: str = ""
    source_url: str = ""
    target_x_pix: Optional[float] = None
    target_y_pix: Optional[float] = None
    frame_meta_url: str = ""
    array_shape: Optional[list[int]] = None
    subtract_zodi: bool = False
    wcs: dict[str, Any] = Field(default_factory=dict)
    central_wavelength_um: Optional[float] = None


class EpochsFullResponse(BaseModel):
    ra: float
    dec: float
    frames: list[FullEpochFrame]
    source: DataSource = DataSource.live
    subtract_zodi: bool = False
    pixel_scale_arcsec: float = 6.15
    note: str = (
        "Full detector frames for blink; target_xy is the WCS pixel of the request "
        "sky position in each epoch (pointings differ)."
    )


class DiffResponse(BaseModel):
    ra: float
    dec: float
    fov_deg: float
    epoch_a: str
    epoch_b: str
    image_url: Optional[str] = None
    source: DataSource = DataSource.live
    note: str = "Difference of aligned cutouts on a common grid."
    wavelength_a_um: Optional[float] = None
    wavelength_b_um: Optional[float] = None
    wavelength_diff_um: Optional[float] = None
    wavelength_tol_um: Optional[float] = None
    wavelength_mismatched: bool = False
    science_ok: bool = True


class PixelInspectorResponse(BaseModel):
    target_id: str
    epoch_id: str
    x_pix: float
    y_pix: float
    image_mjy_sr: Optional[float] = None
    bunit: str = "MJy/sr"
    flags_raw: Optional[int] = None
    flags_set: list[str] = Field(default_factory=list)
    variance: Optional[float] = None
    zodi_mjy_sr: Optional[float] = None
    central_wavelength_um: Optional[float] = None
    wavelength_note: str = (
        "Demo packs store frame-level central λ from WCS-WAVE at the target; "
        "per-cursor LVF λ is not available offline without the full WCS-WAVE grid."
    )
    variance_note: str = "VARIANCE sidecar not packed in demo cutouts — not computed"
    zodi_note: str = "ZODI sidecar not packed in demo cutouts — not computed"
    source: DataSource = DataSource.cached_demo
    is_synthetic: bool = False
    note: Optional[str] = None


class Classification(str, Enum):
    known = "known"
    candidate = "candidate"
    likely_artifact = "likely_artifact"
    stationary_source = "stationary_source"


class MoverTrackPoint(BaseModel):
    epoch_id: str
    mjd: float
    ra: float
    dec: float
    ra_err_arcsec: Optional[float] = None
    dec_err_arcsec: Optional[float] = None


class MoverCandidate(BaseModel):
    id: str
    classification: Classification
    reasons: list[str] = Field(default_factory=list)
    track: list[MoverTrackPoint] = Field(default_factory=list)
    pm_ra_arcsec_yr: Optional[float] = None
    pm_dec_arcsec_yr: Optional[float] = None
    pm_ra_err_arcsec_yr: Optional[float] = None
    pm_dec_err_arcsec_yr: Optional[float] = None
    crossmatch: dict[str, Any] = Field(default_factory=dict)
    is_synthetic: bool = False


class MoversResponse(BaseModel):
    ra: float
    dec: float
    fov_deg: float
    movers: list[MoverCandidate]
    source: DataSource = DataSource.live


class PredictedTrackPoint(BaseModel):
    epoch_id: str
    mjd: float
    ra: float
    dec: float
    x_pix: Optional[float] = None
    y_pix: Optional[float] = None
    ra_err_arcsec: Optional[float] = None
    dec_err_arcsec: Optional[float] = None
    offset_from_catalog_arcsec: Optional[float] = None
    offset_from_catalog_pix: Optional[float] = None
    offset_uncertainty_arcsec: Optional[float] = None
    offset_uncertainty_note: str = "no uncertainty available"
    note: str = ""


class HistoricalMarker(BaseModel):
    id: str
    label: str
    ra: float
    dec: float
    epoch: float
    epoch_note: str = ""
    citation: str = ""
    x_pix: Optional[float] = None
    y_pix: Optional[float] = None
    position_uncertainty_arcsec: Optional[float] = None
    uncertainty_note: str = "no uncertainty available"


class MissingMarker(BaseModel):
    id: str
    label: str
    reason: str


class ProperMotionInfo(BaseModel):
    pm_ra_cosdec_arcsec_yr: float
    pm_dec_arcsec_yr: float
    pm_ra_err: Optional[float] = None
    pm_dec_err: Optional[float] = None
    ref_epoch: float
    citation: str
    uncertainty_note: str
    source: str = "pm_table"


class PredictedTrackResponse(BaseModel):
    name: str
    ra: float
    dec: float
    points: list[PredictedTrackPoint]
    source: DataSource = DataSource.live
    method: str = "catalog proper motion / ephemeris"
    pixel_scale_arcsec: float = 6.15
    historical_markers: list[HistoricalMarker] = []
    missing_markers: list[MissingMarker] = []
    proper_motion: Optional[ProperMotionInfo] = None


class TimeTrackPoint(BaseModel):
    date_iso: str
    decimal_year: float
    mjd: float
    ra: float
    dec: float
    offset_from_catalog_arcsec: float = 0.0
    step_arcsec: float = 0.0


class TimeTrackKeyDate(BaseModel):
    id: str
    kind: str
    label: str
    decimal_year: float
    date_iso: str
    epoch_id: Optional[str] = None
    mjd: Optional[float] = None


class FamiliarMotionUnits(BaseModel):
    arcsec_per_year: float = 0.0
    arcsec_per_decade: float = 0.0
    moon_widths_per_year: float = 0.0
    years_per_moon_width: Optional[float] = None


class MotionSpeedResponse(BaseModel):
    target_id: Optional[str] = None
    name: Optional[str] = None
    is_mover: bool = False
    is_variable_control: bool = False
    pm_ra_cosdec_arcsec_yr: float = 0.0
    pm_dec_arcsec_yr: float = 0.0
    pm_total_arcsec_yr: float = 0.0
    position_angle_deg: Optional[float] = None
    pm_citation: str = ""
    pm_uncertainty_note: str = "no uncertainty available"
    parallax_mas: Optional[float] = None
    parallax_err_mas: Optional[float] = None
    parallax_citation: Optional[str] = None
    parallax_missing_reason: Optional[str] = None
    distance_pc: Optional[float] = None
    distance_ly: Optional[float] = None
    distance_note: str = ""
    tangential_velocity_kms: Optional[float] = None
    radial_velocity_kms: Optional[float] = None
    radial_velocity_citation: Optional[str] = None
    radial_velocity_url: Optional[str] = None
    radial_velocity_note: Optional[str] = None
    solar_speed_kms: Optional[float] = None
    tangential_velocity_note: str = ""
    familiar: FamiliarMotionUnits = Field(default_factory=FamiliarMotionUnits)
    formula_note: str = ""


class TimeTrackResponse(BaseModel):
    target_id: Optional[str] = None
    name: Optional[str] = None
    is_mover: bool = False
    start_year: float
    end_year: float
    n: int
    catalog_ra: float
    catalog_dec: float
    ref_epoch: float
    proper_motion: dict[str, Any] = Field(default_factory=dict)
    points: list[TimeTrackPoint]
    key_dates: list[TimeTrackKeyDate] = []
    motion_speed: Optional[MotionSpeedResponse] = None
    honesty: str = (
        "Predicted from catalog proper motion (source and uncertainty), not a detection."
    )
    non_mover_message: Optional[str] = None
    method: str = ""
    source: str = "pm_table"


class SpectrumPoint(BaseModel):
    wavelength_um: float
    flux: float
    flux_err: Optional[float] = None
    detector: Optional[int] = None
    bandpass: Optional[str] = None


class SpectrumResponse(BaseModel):
    ra: float
    dec: float
    points: list[SpectrumPoint]
    source: DataSource = DataSource.live
    unit: str = "MJy/sr (surface brightness; conversion to point-source flux TBD)"
    method_note: str = ""
    is_synthetic: bool = False


class ScoreboardResponse(BaseModel):
    source: DataSource = DataSource.live
    results: dict[str, Any] = Field(default_factory=dict)
    is_synthetic_injected: bool = False
    explanation: str = ""


class ChangeScoreFrame(BaseModel):
    epoch_id: str
    mjd: float
    wavelength_um: Optional[float] = None
    detector: Optional[int] = None
    score: Optional[float] = None
    score_err: Optional[float] = None
    score_unit: str = "dimensionless (S/N)"
    brightness_snr: Optional[float] = None
    brightness_snr_err: Optional[float] = None
    position_shift_pix: Optional[float] = None
    position_shift_pix_err: Optional[float] = None
    position_shift_arcsec: Optional[float] = None
    position_shift_arcsec_err: Optional[float] = None
    centroid_x: Optional[float] = None
    centroid_y: Optional[float] = None
    masked_fraction: float = 0.0
    n_aperture_pixels: int = 0
    n_masked: int = 0
    wavelength_mismatched: bool = False
    wavelength_diff_um: Optional[float] = None
    status: Literal["ok", "not_computed"] = "ok"
    status_reason: str = ""
    approximate: bool = False
    approximate_reason: str = ""
    is_synthetic: bool = False
    notes: list[str] = Field(default_factory=list)


class ChangeScoresResponse(BaseModel):
    ra: float
    dec: float
    radius_pix: float
    metric: Literal["brightness_snr", "position_shift", "combined"]
    reference: Literal["median_others", "first_epoch", "previous_epoch"]
    frames: list[ChangeScoreFrame]
    motion: dict[str, Any] = Field(default_factory=dict)
    source: DataSource = DataSource.live
    pixel_scale_arcsec: float = 6.15
    aperture_x_pix: Optional[float] = None
    aperture_y_pix: Optional[float] = None
    is_synthetic: bool = False
    banner: Optional[str] = None
    wavelength_tol_um: Optional[float] = None
    n_wavelength_excluded: int = 0
    wavelength_status: Optional[str] = None
    wavelength_message: Optional[str] = None
    metric_note: str = (
        "Change = difference from reference in the aperture (candidates only; "
        "not a discovery). See docs/SCIENCE_LIMITS.md."
    )
