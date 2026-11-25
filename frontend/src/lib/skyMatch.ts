/** Match requested sky center to a demo-cache manifest center (Bug 1). */

/** ~72″ — small vs 0.15–0.2° demo FOV. */
export const CACHE_POSITION_TOL_DEG = 0.02;

export function positionsMatch(
  raA: number,
  decA: number,
  raB: number,
  decB: number,
  tolDeg: number = CACHE_POSITION_TOL_DEG,
): boolean {
  if (![raA, decA, raB, decB, tolDeg].every(Number.isFinite)) return false;
  if (tolDeg < 0) return false;
  const midDec = 0.5 * (decA + decB);
  const cosd = Math.max(Math.cos((midDec * Math.PI) / 180), 1e-6);
  const dra = (raA - raB) * cosd;
  const ddec = decA - decB;
  return Math.hypot(dra, ddec) <= tolDeg;
}

/** Match request to cutout CRVAL and/or catalog-epoch coords (mirrors backend). */
export function manifestCenterMatch(
  ra: number,
  dec: number,
  man: {
    ra?: number;
    dec?: number;
    catalog_ra?: number;
    catalog_dec?: number;
  },
  tolDeg: number = CACHE_POSITION_TOL_DEG,
): boolean {
  const candidates: [number, number][] = [];
  if (man.ra != null && man.dec != null && Number.isFinite(man.ra) && Number.isFinite(man.dec)) {
    candidates.push([man.ra, man.dec]);
  }
  if (
    man.catalog_ra != null &&
    man.catalog_dec != null &&
    Number.isFinite(man.catalog_ra) &&
    Number.isFinite(man.catalog_dec)
  ) {
    candidates.push([man.catalog_ra, man.catalog_dec]);
  }
  return candidates.some(([cra, cdec]) => positionsMatch(ra, dec, cra, cdec, tolDeg));
}
