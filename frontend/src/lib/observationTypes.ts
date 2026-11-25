import type { PixelRect, SkyCorner } from "./highlightMath";

export type ObjectGuess =
  | "not_sure"
  | "asteroid_sso"
  | "nearby_high_pm"
  | "variable_or_brightness"
  | "image_artifact"
  | "cosmic_ray"
  | "other"
  | "simulated_injection";

export type DirectionGuess =
  | "up"
  | "down"
  | "left"
  | "right"
  | "up_left"
  | "up_right"
  | "down_left"
  | "down_right"
  | "brightness_only"
  | "not_sure";

export type EaseSeen = "obvious" | "subtle" | "after_zoom";

export interface FrameHighlightState {
  epoch_id: string;
  mode: "default" | "custom";
  pixel: PixelRect;
  sky_corners: SkyCorner[];
}

export interface FrozenReportContext {
  batchId?: string;
  imageMode?: "full_frame" | "target_crop";
  targetId?: string;
  targetName?: string;
  ra: number;
  dec: number;
  raDecSource: string;
  fovDeg: number;
  dataSource: string;
  frames: import("../types").CutoutFrame[];
  keptEpochIds: string[];
  shareUrl: string;
  display: Record<string, unknown>;
  imageWidth: number;
  imageHeight: number;
  pixelScaleArcsec: number;
}

export interface ObservationDraft {
  selectedEpochIds: string[];
  defaultRect: PixelRect | null;
  highlights: Record<string, FrameHighlightState>;
  description: string;
  objectGuess: ObjectGuess;
  objectGuessOther: string;
  direction: DirectionGuess;
  confidence: number;
  ease: EaseSeen | "";
  contactEmail: string;
  contactConsent: boolean;
  storeConsent: boolean;
  isSyntheticFlag: boolean;
  formOpenedAt: number;
  idempotencyKey: string;
}
