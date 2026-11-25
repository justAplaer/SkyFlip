/**
 * Select-zoom viewport math for the blink player.
 * Coordinates are in native image pixels of the common reprojected grid.
 */

export const PIXEL_SCALE_ARCSEC = 6.15; // SPHEREx Spectral Image (docs/DATA_NOTES.md)
export const MIN_SELECTION_PIX = 3;
export const CSS_CANVAS = 480;

export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ImageBounds {
  width: number;
  height: number;
}

export function rectWidth(r: ViewRect): number {
  return Math.abs(r.x1 - r.x0);
}

export function rectHeight(r: ViewRect): number {
  return Math.abs(r.y1 - r.y0);
}

export function normalizeRect(r: ViewRect): ViewRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

export function fullImageRect(bounds: ImageBounds): ViewRect {
  return { x0: 0, y0: 0, x1: bounds.width, y1: bounds.height };
}

export function rectEquals(a: ViewRect, b: ViewRect, eps = 1e-6): boolean {
  return (
    Math.abs(a.x0 - b.x0) < eps &&
    Math.abs(a.y0 - b.y0) < eps &&
    Math.abs(a.x1 - b.x1) < eps &&
    Math.abs(a.y1 - b.y1) < eps
  );
}

/** Expand drag box to match target aspect (width/height), centered on drag, then clamp. */
export function expandToAspect(
  drag: ViewRect,
  aspect: number,
  bounds: ImageBounds,
): ViewRect {
  const n = normalizeRect(drag);
  let w = rectWidth(n);
  let h = rectHeight(n);
  if (w < 1e-9) w = 1;
  if (h < 1e-9) h = 1;
  const cx = (n.x0 + n.x1) / 2;
  const cy = (n.y0 + n.y1) / 2;
  const dragAspect = w / h;
  if (dragAspect < aspect) {
    // too tall → widen
    w = h * aspect;
  } else {
    // too wide → heighten
    h = w / aspect;
  }
  const expanded: ViewRect = {
    x0: cx - w / 2,
    y0: cy - h / 2,
    x1: cx + w / 2,
    y1: cy + h / 2,
  };
  return clampRect(expanded, bounds);
}

/** Keep rect inside image; preserve size when possible by shifting. */
export function clampRect(r: ViewRect, bounds: ImageBounds): ViewRect {
  let n = normalizeRect(r);
  let w = rectWidth(n);
  let h = rectHeight(n);
  w = Math.min(w, bounds.width);
  h = Math.min(h, bounds.height);
  let x0 = n.x0;
  let y0 = n.y0;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x0 + w > bounds.width) x0 = bounds.width - w;
  if (y0 + h > bounds.height) y0 = bounds.height - h;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function meetsMinSize(r: ViewRect, minPix = MIN_SELECTION_PIX): boolean {
  const n = normalizeRect(r);
  return rectWidth(n) >= minPix && rectHeight(n) >= minPix;
}

/** Map canvas CSS coords → image pixels given current viewport. */
export function canvasToImage(
  cx: number,
  cy: number,
  view: ViewRect,
  canvasSize = CSS_CANVAS,
): { x: number; y: number } {
  const v = normalizeRect(view);
  const x = v.x0 + (cx / canvasSize) * rectWidth(v);
  const y = v.y0 + (cy / canvasSize) * rectHeight(v);
  return { x, y };
}

/** Map image pixels → canvas CSS coords. */
export function imageToCanvas(
  ix: number,
  iy: number,
  view: ViewRect,
  canvasSize = CSS_CANVAS,
): { x: number; y: number } {
  const v = normalizeRect(view);
  const w = rectWidth(v) || 1;
  const h = rectHeight(v) || 1;
  return {
    x: ((ix - v.x0) / w) * canvasSize,
    y: ((iy - v.y0) / h) * canvasSize,
  };
}

/** Zoom centered on image point by factor (>1 zooms in). */
export function zoomAtPoint(
  view: ViewRect,
  imageX: number,
  imageY: number,
  factor: number,
  bounds: ImageBounds,
  aspect: number,
): ViewRect {
  const v = normalizeRect(view);
  const w = rectWidth(v) / factor;
  const h = w / aspect;
  const fx = (imageX - v.x0) / (rectWidth(v) || 1);
  const fy = (imageY - v.y0) / (rectHeight(v) || 1);
  const next: ViewRect = {
    x0: imageX - fx * w,
    y0: imageY - fy * h,
    x1: imageX + (1 - fx) * w,
    y1: imageY + (1 - fy) * h,
  };
  // Don't zoom out past full image
  if (rectWidth(next) >= bounds.width && rectHeight(next) >= bounds.height) {
    return fullImageRect(bounds);
  }
  return clampRect(expandToAspect(next, aspect, bounds), bounds);
}

export function panView(
  view: ViewRect,
  dImageX: number,
  dImageY: number,
  bounds: ImageBounds,
): ViewRect {
  const v = normalizeRect(view);
  return clampRect(
    {
      x0: v.x0 + dImageX,
      y0: v.y0 + dImageY,
      x1: v.x1 + dImageX,
      y1: v.y1 + dImageY,
    },
    bounds,
  );
}

export function fovArcsec(view: ViewRect): { w: number; h: number } {
  const v = normalizeRect(view);
  return {
    w: rectWidth(v) * PIXEL_SCALE_ARCSEC,
    h: rectHeight(v) * PIXEL_SCALE_ARCSEC,
  };
}

export function selectionReadout(r: ViewRect): string {
  const v = normalizeRect(r);
  const w = rectWidth(v);
  const h = rectHeight(v);
  return `${w.toFixed(1)}×${h.toFixed(1)} px · ${(w * PIXEL_SCALE_ARCSEC).toFixed(1)}×${(h * PIXEL_SCALE_ARCSEC).toFixed(1)}″`;
}

export class ZoomStack {
  private stack: ViewRect[] = [];

  constructor(initial?: ViewRect) {
    if (initial) this.stack = [normalizeRect(initial)];
  }

  current(): ViewRect | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  push(next: ViewRect): ViewRect {
    const n = normalizeRect(next);
    const cur = this.current();
    if (cur && rectEquals(cur, n)) return cur;
    this.stack.push(n);
    return n;
  }

  back(): ViewRect | null {
    if (this.stack.length <= 1) return this.current();
    this.stack.pop();
    return this.current();
  }

  reset(full: ViewRect): ViewRect {
    this.stack = [normalizeRect(full)];
    return this.stack[0];
  }

  depth(): number {
    return this.stack.length;
  }

  canBack(): boolean {
    return this.stack.length > 1;
  }

  replaceTop(next: ViewRect): ViewRect {
    const n = normalizeRect(next);
    if (!this.stack.length) {
      this.stack = [n];
      return n;
    }
    this.stack[this.stack.length - 1] = n;
    return n;
  }
}

/** Linear interpolate for animated zoom. */
export function lerpRect(a: ViewRect, b: ViewRect, t: number): ViewRect {
  const u = Math.min(1, Math.max(0, t));
  return {
    x0: a.x0 + (b.x0 - a.x0) * u,
    y0: a.y0 + (b.y0 - a.y0) * u,
    x1: a.x1 + (b.x1 - a.x1) * u,
    y1: a.y1 + (b.y1 - a.y1) * u,
  };
}
