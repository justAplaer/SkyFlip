/**
 * Observation highlight rectangles: pixel ↔ approximate sky (TAN).
 * When frames share a common reprojected grid, pixel coords are equivalent;
 * we still store BOTH pixel and RA/Dec corners in the report.
 */

export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SkyCorner {
  ra: number;
  dec: number;
}

export interface TanWcsApprox {
  crvalRa: number;
  crvalDec: number;
  crpixX: number; // 0-based center-ish
  crpixY: number;
  scaleDeg: number; // degrees per pixel (cdelt magnitude)
  /** Standard TAN: +RA → −x */
  raSign: -1 | 1;
}

export const MAX_HIGHLIGHT_FRAC = 0.5;

export function normalizeRect(r: PixelRect): PixelRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

export function rectArea(r: PixelRect): number {
  const n = normalizeRect(r);
  return Math.abs(n.x1 - n.x0) * Math.abs(n.y1 - n.y0);
}

export function rectValid(
  r: PixelRect,
  width: number,
  height: number,
  maxFrac = MAX_HIGHLIGHT_FRAC,
): { ok: boolean; reason?: string } {
  const n = normalizeRect(r);
  if (n.x1 - n.x0 <= 0 || n.y1 - n.y0 <= 0) {
    return { ok: false, reason: "Highlight must have non-zero size." };
  }
  if (n.x0 < -0.5 || n.y0 < -0.5 || n.x1 > width + 0.5 || n.y1 > height + 0.5) {
    return { ok: false, reason: "Highlight must stay inside the image." };
  }
  const imgArea = width * height;
  if (imgArea > 0 && rectArea(n) > maxFrac * imgArea) {
    return {
      ok: false,
      reason: `Highlight covers more than ${Math.round(maxFrac * 100)}% of the frame.`,
    };
  }
  return { ok: true };
}

/** Approximate pixel → sky using small-field TAN. */
export function pixelToSky(x: number, y: number, wcs: TanWcsApprox): SkyCorner {
  const cosd = Math.cos((wcs.crvalDec * Math.PI) / 180) || 1e-6;
  const dx = x - wcs.crpixX;
  const dy = y - wcs.crpixY;
  const dra = (wcs.raSign * dx * wcs.scaleDeg) / cosd;
  const ddec = dy * wcs.scaleDeg;
  return { ra: wcs.crvalRa + dra, dec: wcs.crvalDec + ddec };
}

export function skyToPixel(ra: number, dec: number, wcs: TanWcsApprox): { x: number; y: number } {
  const cosd = Math.cos((wcs.crvalDec * Math.PI) / 180) || 1e-6;
  const dra = ra - wcs.crvalRa;
  const ddec = dec - wcs.crvalDec;
  const dx = (wcs.raSign * dra * cosd) / wcs.scaleDeg;
  const dy = ddec / wcs.scaleDeg;
  return { x: wcs.crpixX + dx, y: wcs.crpixY + dy };
}

export function rectToSkyCorners(r: PixelRect, wcs: TanWcsApprox): SkyCorner[] {
  const n = normalizeRect(r);
  return [
    pixelToSky(n.x0, n.y0, wcs),
    pixelToSky(n.x1, n.y0, wcs),
    pixelToSky(n.x1, n.y1, wcs),
    pixelToSky(n.x0, n.y1, wcs),
  ];
}

/** Map a pixel rect from frame A WCS onto frame B via sky corners → bounding box. */
export function mapRectViaSky(
  rectA: PixelRect,
  wcsA: TanWcsApprox,
  wcsB: TanWcsApprox,
): PixelRect {
  const corners = rectToSkyCorners(rectA, wcsA).map((c) => skyToPixel(c.ra, c.dec, wcsB));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return normalizeRect({
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  });
}

export function defaultTanWcs(
  fieldRa: number,
  fieldDec: number,
  width: number,
  height: number,
  pixelScaleArcsec = 6.15,
): TanWcsApprox {
  return {
    crvalRa: fieldRa,
    crvalDec: fieldDec,
    crpixX: (width - 1) / 2,
    crpixY: (height - 1) / 2,
    scaleDeg: pixelScaleArcsec / 3600,
    raSign: -1,
  };
}

/** Position angle of motion from first→last highlight center (deg E of N), or null. */
export function computedDirectionPa(
  rects: PixelRect[],
  wcs: TanWcsApprox,
): { paDeg: number; label: string } | null {
  if (rects.length < 2) return null;
  const a = normalizeRect(rects[0]);
  const b = normalizeRect(rects[rects.length - 1]);
  const c0 = pixelToSky((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, wcs);
  const c1 = pixelToSky((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, wcs);
  const cosd = Math.cos((c0.dec * Math.PI) / 180) || 1e-6;
  const east = (c1.ra - c0.ra) * cosd;
  const north = c1.dec - c0.dec;
  if (Math.hypot(east, north) < 1e-12) {
    return { paDeg: 0, label: "no sky displacement" };
  }
  let pa = (Math.atan2(east, north) * 180) / Math.PI;
  if (pa < 0) pa += 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(pa / 45) % 8;
  return { paDeg: pa, label: dirs[idx] };
}
