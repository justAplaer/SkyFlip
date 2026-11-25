import type { CutoutFrame } from "../types";
import { parseTanWcs, type TanWcs } from "./wcsSky";

const DEFAULT_SCALE_ARCSEC = 6.15;

/**
 * Prefer the frame's own WCS header. If missing (some demo packs), synthesize a
 * TAN WCS centered on the field CRVAL with SPHEREx pixel scale.
 * Pixels are 0-indexed for canvas; FITS CRPIX remains 1-based inside TanWcs.
 */
export function frameWcs(
  frame: CutoutFrame | undefined,
  fieldRa?: number,
  fieldDec?: number,
  pixelScaleArcsec: number = DEFAULT_SCALE_ARCSEC,
): TanWcs | null {
  if (!frame) return null;
  const ny =
    frame.float_shape?.[0] ??
    frame.image_shape?.[0] ??
    frame.array_shape?.[0] ??
    0;
  const nx =
    frame.float_shape?.[1] ??
    frame.image_shape?.[1] ??
    frame.array_shape?.[1] ??
    0;
  if (frame.wcs && Object.keys(frame.wcs).length > 0) {
    const parsed = parseTanWcs(frame.wcs, nx > 0 && ny > 0 ? { nx, ny } : undefined);
    if (parsed) return parsed;
  }
  if (
    fieldRa == null ||
    fieldDec == null ||
    !Number.isFinite(fieldRa) ||
    !Number.isFinite(fieldDec) ||
    nx < 2 ||
    ny < 2
  ) {
    return null;
  }
  const scale = pixelScaleArcsec / 3600;
  return parseTanWcs(
    {
      CRPIX1: (nx + 1) / 2,
      CRPIX2: (ny + 1) / 2,
      CRVAL1: fieldRa,
      CRVAL2: fieldDec,
      CDELT1: -scale,
      CDELT2: scale,
      NAXIS1: nx,
      NAXIS2: ny,
    },
    { nx, ny },
  );
}

/** True when 0-based pixel is inside the array with the given margin. */
export function pixelInside(
  x: number,
  y: number,
  nx: number,
  ny: number,
  margin = 0,
): boolean {
  return x >= margin && y >= margin && x < nx - margin && y < ny - margin;
}
