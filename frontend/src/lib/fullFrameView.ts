/** Shared view model for the full-frame tiled viewer (screen px per image px). */

export type FullFrameView = {
  /** Sky center held across epochs (WCS-aligned blink). */
  centerRa: number;
  centerDec: number;
  /** CSS pixels per native (level-0) image pixel. */
  scale: number;
};

export type ToolMode = "pan" | "box" | "select";

export const MAX_SCALE = 16;
export const ZOOM_STEP = 1.5;
export const MIN_BOX_CSS_PX = 5;
export const VIEW_HISTORY_MAX = 20;

export function fitScaleFor(nx: number, ny: number, cssSize: number): number {
  if (nx < 1 || ny < 1) return 0.3;
  return Math.min(cssSize / nx, cssSize / ny) * 0.95;
}

export function clampScale(scale: number, fit: number): number {
  const lo = Math.min(fit, fit * 0.5);
  return Math.min(MAX_SCALE, Math.max(lo, scale));
}

export function zoomAround(
  view: FullFrameView,
  factor: number,
  fit: number,
): FullFrameView {
  return { ...view, scale: clampScale(view.scale * factor, fit) };
}

/** Zoom so the image-pixel box fills the CSS canvas (aspect preserved). */
export function viewFromImageBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  _centerRa: number,
  _centerDec: number,
  fit: number,
  cssSize: number,
  pixelToSky: (x: number, y: number) => { ra: number; dec: number },
): FullFrameView {
  void _centerRa;
  void _centerDec;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const sky = pixelToSky(cx, cy);
  const scale = clampScale(Math.min(cssSize / Math.max(w, 1e-6), cssSize / Math.max(h, 1e-6)), fit);
  return { centerRa: sky.ra, centerDec: sky.dec, scale };
}

export function pushHistory(
  stack: FullFrameView[],
  view: FullFrameView,
  max = VIEW_HISTORY_MAX,
): FullFrameView[] {
  const next = [...stack, { ...view }];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function framesSignature(frames: { epoch_id: string }[]): string {
  return frames.map((f) => f.epoch_id).join("|");
}
