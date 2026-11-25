/** Minimal TAN/CD WCS helpers for sky↔pixel (browser; no astropy). */

export type WcsHeader = Record<string, unknown>;

function num(h: WcsHeader, key: string, fallback = 0): number {
  const v = h[key] ?? h[key.toUpperCase()] ?? h[key.toLowerCase()];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface TanWcs {
  crpix1: number;
  crpix2: number;
  crval1: number;
  crval2: number;
  /** degrees per pixel; CD matrix preferred over CDELT. */
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
  naxis1: number;
  naxis2: number;
}

export function parseTanWcs(h: WcsHeader, shape?: { nx: number; ny: number }): TanWcs | null {
  const crpix1 = num(h, "CRPIX1", NaN);
  const crpix2 = num(h, "CRPIX2", NaN);
  const crval1 = num(h, "CRVAL1", NaN);
  const crval2 = num(h, "CRVAL2", NaN);
  if (![crpix1, crpix2, crval1, crval2].every(Number.isFinite)) return null;

  let cd11 = num(h, "CD1_1", NaN);
  let cd12 = num(h, "CD1_2", 0);
  let cd21 = num(h, "CD2_1", 0);
  let cd22 = num(h, "CD2_2", NaN);
  if (!Number.isFinite(cd11) || !Number.isFinite(cd22)) {
    const cdelt1 = num(h, "CDELT1", NaN);
    const cdelt2 = num(h, "CDELT2", NaN);
    const crota = (num(h, "CROTA2", 0) * Math.PI) / 180;
    if (!Number.isFinite(cdelt1) || !Number.isFinite(cdelt2)) return null;
    const cos = Math.cos(crota);
    const sin = Math.sin(crota);
    cd11 = cdelt1 * cos;
    cd12 = -cdelt2 * sin;
    cd21 = cdelt1 * sin;
    cd22 = cdelt2 * cos;
  }

  return {
    crpix1,
    crpix2,
    crval1,
    crval2,
    cd11,
    cd12,
    cd21,
    cd22,
    naxis1: shape?.nx ?? num(h, "NAXIS1", 2040),
    naxis2: shape?.ny ?? num(h, "NAXIS2", 2040),
  };
}

/** World (RA, Dec deg) → pixel (x, y) 0-indexed FITS-like (same as astropy world_to_pixel). */
export function worldToPixel(wcs: TanWcs, ra: number, dec: number): { x: number; y: number } {
  const dra = (ra - wcs.crval1) * Math.cos((wcs.crval2 * Math.PI) / 180);
  const ddec = dec - wcs.crval2;
  const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  if (Math.abs(det) < 1e-30) return { x: wcs.crpix1 - 1, y: wcs.crpix2 - 1 };
  const dx = (wcs.cd22 * dra - wcs.cd12 * ddec) / det;
  const dy = (-wcs.cd21 * dra + wcs.cd11 * ddec) / det;
  // FITS CRPIX is 1-indexed; return 0-indexed for canvas
  return { x: wcs.crpix1 - 1 + dx, y: wcs.crpix2 - 1 + dy };
}

/** Pixel (0-indexed) → RA/Dec deg. */
export function pixelToWorld(wcs: TanWcs, x: number, y: number): { ra: number; dec: number } {
  const dx = x - (wcs.crpix1 - 1);
  const dy = y - (wcs.crpix2 - 1);
  const dra = wcs.cd11 * dx + wcs.cd12 * dy;
  const ddec = wcs.cd21 * dx + wcs.cd22 * dy;
  const ra = wcs.crval1 + dra / Math.cos((wcs.crval2 * Math.PI) / 180);
  const dec = wcs.crval2 + ddec;
  return { ra, dec };
}

export function pixelInFrame(wcs: TanWcs, x: number, y: number, margin = 0): boolean {
  return x >= -margin && y >= -margin && x < wcs.naxis1 + margin && y < wcs.naxis2 + margin;
}
