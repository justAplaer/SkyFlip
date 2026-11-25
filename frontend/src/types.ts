export type DataSource = "live" | "cached-demo";

export interface HealthResponse {
  status: string;
  source: DataSource;
  services: Record<string, { ok: boolean; detail?: string }>;
  demo_cache_available: boolean;
  pixel_scale_arcsec: number;
}

export interface ResolveResponse {
  name: string;
  ra: number;
  dec: number;
  source: DataSource;
  catalog: string;
  uncertainty_arcsec: number | null;
  uncertainty_note: string;
}

export interface CutoutFrame {
  epoch_id: string;
  obs_id: string;
  mjd: number;
  time_iso: string;
  bandpass: string;
  detector: number;
  image_url: string;
  central_wavelength_um?: number | null;
  flag_summary?: Record<string, number>;
  is_synthetic?: boolean;
  /** Optional float32 little-endian .bin from IRSA IMAGE (browser stretch). */
  float_bin?: string;
  float_shape?: [number, number];
  flags_bin?: string;
  bunit?: string;
  collection?: string;
  native_dtype?: string;
  png_unique_gray_levels?: number;
  /** Real IRSA IBE cutout URL when known (live or cached manifest). */
  cutout_url?: string;
  image_shape?: [number, number];
  background_note?: string;
  /** Labeled PNG display stamp (saturation-blanked IMAGE); float .bin unaltered. */
  png_display_assist?: boolean;
  png_display_note?: string;
  /** Full-frame / tiled viewer fields */
  source_url?: string | null;
  array_shape?: [number, number] | number[] | null;
  target_x_pix?: number | null;
  target_y_pix?: number | null;
  subtract_zodi?: boolean;
  view_mode?: "full_frame" | "target_crop" | "overview";
  frame_meta_url?: string | null;
  wcs?: Record<string, unknown>;
  stretch_hint?: Record<string, number>;
}

export interface FramePyramidMeta {
  obs_id: string;
  detector: number;
  shape: [number, number] | number[];
  naxis1: number;
  naxis2: number;
  tile_size: number;
  n_levels: number;
  subtract_zodi: boolean;
  bunit: string;
  source_url: string;
  mjd: number;
  time_iso: string;
  bandpass: string;
  wcs: Record<string, unknown>;
  stats: Record<string, number>;
  units?: string;
  collection?: string;
  target_x_pix?: number | null;
  target_y_pix?: number | null;
  central_wavelength_um?: number | null;
}

export interface CutoutsResponse {
  ra: number;
  dec: number;
  /** Catalog-epoch coords when cutout CRVAL is SPHEREx-era (high-PM packs). */
  catalog_ra?: number;
  catalog_dec?: number;
  fov_deg: number;
  frames: CutoutFrame[];
  source: DataSource;
  pixel_scale_arcsec: number;
  note?: string | null;
  stack?: string;
  subtract_zodi?: boolean;
  view_mode?: "full_frame" | "target_crop" | "overview";
}

export interface PredictedTrackPoint {
  epoch_id: string;
  mjd: number;
  ra: number;
  dec: number;
  /** Pixel coords in the matching frame (native cutout grid). */
  x_pix?: number | null;
  y_pix?: number | null;
  ra_err_arcsec?: number | null;
  dec_err_arcsec?: number | null;
  offset_from_catalog_arcsec?: number | null;
  offset_from_catalog_pix?: number | null;
  offset_uncertainty_arcsec?: number | null;
  offset_uncertainty_note?: string;
  note?: string;
}

export interface HistoricalMarker {
  id: string;
  label: string;
  ra: number;
  dec: number;
  epoch: number;
  epoch_note?: string;
  citation?: string;
  x_pix?: number | null;
  y_pix?: number | null;
  position_uncertainty_arcsec?: number | null;
  uncertainty_note?: string;
}

export interface MissingMarker {
  id: string;
  label: string;
  reason: string;
}

export interface ProperMotionInfo {
  pm_ra_cosdec_arcsec_yr: number;
  pm_dec_arcsec_yr: number;
  pm_ra_err?: number | null;
  pm_dec_err?: number | null;
  ref_epoch: number;
  citation: string;
  uncertainty_note: string;
  source: string;
}

export interface FamiliarMotionUnits {
  arcsec_per_year: number;
  arcsec_per_decade: number;
  moon_widths_per_year: number;
  years_per_moon_width: number | null;
}

export interface MotionSpeedInfo {
  target_id?: string | null;
  name?: string | null;
  is_mover: boolean;
  is_variable_control?: boolean;
  pm_ra_cosdec_arcsec_yr: number;
  pm_dec_arcsec_yr: number;
  pm_total_arcsec_yr: number;
  position_angle_deg?: number | null;
  pm_citation: string;
  pm_uncertainty_note: string;
  parallax_mas?: number | null;
  parallax_err_mas?: number | null;
  parallax_citation?: string | null;
  parallax_missing_reason?: string | null;
  distance_pc?: number | null;
  distance_ly?: number | null;
  distance_note?: string;
  tangential_velocity_kms?: number | null;
  radial_velocity_kms?: number | null;
  radial_velocity_citation?: string | null;
  radial_velocity_url?: string | null;
  radial_velocity_note?: string | null;
  solar_speed_kms?: number | null;
  tangential_velocity_note?: string;
  familiar: FamiliarMotionUnits;
  formula_note?: string;
}

export interface TimeTrackPoint {
  date_iso: string;
  decimal_year: number;
  mjd: number;
  ra: number;
  dec: number;
  offset_from_catalog_arcsec?: number;
  step_arcsec?: number;
}

export interface TimeTrackKeyDate {
  id: string;
  kind: string;
  label: string;
  decimal_year: number;
  date_iso: string;
  epoch_id?: string | null;
  mjd?: number | null;
}

export interface TimeTrackResponse {
  target_id?: string | null;
  name?: string | null;
  is_mover: boolean;
  start_year: number;
  end_year: number;
  n: number;
  catalog_ra: number;
  catalog_dec: number;
  ref_epoch: number;
  proper_motion: Record<string, unknown>;
  points: TimeTrackPoint[];
  key_dates: TimeTrackKeyDate[];
  motion_speed?: MotionSpeedInfo | null;
  honesty: string;
  non_mover_message?: string | null;
  method: string;
  source: string;
}

export interface PredictedTrackResponse {
  name: string;
  ra: number;
  dec: number;
  points: PredictedTrackPoint[];
  source: DataSource | string;
  method: string;
  pixel_scale_arcsec: number;
  historical_markers?: HistoricalMarker[];
  missing_markers?: MissingMarker[];
  proper_motion?: ProperMotionInfo | null;
}

export interface SpectrumPoint {
  wavelength_um: number;
  flux: number;
  flux_err?: number | null;
  detector?: number;
  bandpass?: string;
}

export interface MoverCandidate {
  id: string;
  classification: "known" | "candidate" | "likely_artifact" | "stationary_source";
  reasons: string[];
  track: { epoch_id: string; mjd: number; ra: number; dec: number; ra_err_arcsec?: number; dec_err_arcsec?: number }[];
  pm_ra_arcsec_yr?: number | null;
  pm_dec_arcsec_yr?: number | null;
  pm_ra_err_arcsec_yr?: number | null;
  pm_dec_err_arcsec_yr?: number | null;
  crossmatch?: Record<string, unknown>;
  is_synthetic: boolean;
}

export interface TestTarget {
  id: string;
  name: string;
  ra?: number;
  dec?: number;
  resolve?: boolean;
}

/** SPHEREx-era cutout CRVAL from the demo pack (high-PM targets differ from catalog epoch). */
export const WISE0855 = {
  id: "wise0855",
  name: "WISE 0855",
  ra: 133.76047590770844,
  dec: -7.24216033045264,
};

export type ChangeMetric = "brightness_snr" | "position_shift" | "combined";
export type ChangeReference = "median_others" | "first_epoch" | "previous_epoch";
export type ChangeSortMode = "time" | "change";

export interface ChangeScoreFrame {
  epoch_id: string;
  mjd: number;
  wavelength_um?: number | null;
  detector?: number | null;
  score: number | null;
  score_err: number | null;
  score_unit: string;
  brightness_snr?: number | null;
  brightness_snr_err?: number | null;
  position_shift_pix?: number | null;
  position_shift_pix_err?: number | null;
  position_shift_arcsec?: number | null;
  position_shift_arcsec_err?: number | null;
  centroid_x?: number | null;
  centroid_y?: number | null;
  masked_fraction: number;
  n_aperture_pixels: number;
  n_masked: number;
  wavelength_mismatched: boolean;
  wavelength_diff_um?: number | null;
  status: "ok" | "not_computed";
  status_reason?: string;
  approximate?: boolean;
  approximate_reason?: string;
  is_synthetic?: boolean;
  notes?: string[];
}

export interface ChangeScoresResponse {
  ra: number;
  dec: number;
  radius_pix: number;
  metric: ChangeMetric;
  reference: ChangeReference;
  frames: ChangeScoreFrame[];
  motion: Record<string, unknown>;
  source: DataSource;
  pixel_scale_arcsec: number;
  aperture_x_pix?: number | null;
  aperture_y_pix?: number | null;
  is_synthetic?: boolean;
  banner?: string | null;
  wavelength_tol_um?: number | null;
  n_wavelength_excluded?: number;
  wavelength_status?: string | null;
  wavelength_message?: string | null;
  metric_note?: string;
}

export interface TrailPoint {
  epoch_id: string;
  mjd: number;
  x: number;
  y: number;
  score?: number | null;
  index: number;
}

/** RA/Dec = demo cutout CRVAL (SPHEREx-era) so offline/live centers match the pack. */
export const TEST_TARGETS: TestTarget[] = [
  {
    id: "barnards_star",
    name: "Barnard's Star",
    ra: 269.4498066114646,
    dec: 4.72261620254166,
    resolve: true,
  },
  {
    id: "epsilon_indi_b",
    name: "Epsilon Indi B",
    ra: 331.06430332553873,
    dec: -56.78991037447197,
    resolve: true,
  },
  WISE0855,
  {
    id: "rw_aurigae",
    name: "RW Aurigae",
    ra: 76.95652603458,
    dec: 30.40143817389,
    resolve: true,
  },
  {
    id: "r_draconis",
    name: "R Draconis",
    ra: 248.16761083295,
    dec: 66.75497941722,
    resolve: true,
  },
];
