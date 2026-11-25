/** Time-machine helpers: interpolate track, format dates, arc length. */

export interface TimeTrackSkyPoint {
  date_iso: string;
  decimal_year: number;
  mjd: number;
  ra: number;
  dec: number;
  offset_from_catalog_arcsec?: number;
  step_arcsec?: number;
}

export const TIME_MACHINE_START = 2010;
export const TIME_MACHINE_END = 2035;
export const PIXEL_SCALE_ARCSEC = 6.15;
export const MOON_WIDTH_ARCSEC = 1800;

/** Parse `?t=` share param: ISO date or decimal year → decimal year. */
export function parseShareTime(raw: string | undefined | null): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 1900 && asNum < 2100) {
    return clampYear(asNum);
  }
  // ISO date YYYY-MM-DD or YYYY-MM
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3] ?? "15");
    if (![y, mo, d].every(Number.isFinite)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return clampYear(dateToDecimalYear(dt));
  }
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return clampYear(dateToDecimalYear(dt));
  return null;
}

export function clampYear(y: number): number {
  return Math.min(TIME_MACHINE_END, Math.max(TIME_MACHINE_START, y));
}

export function dateToDecimalYear(d: Date): number {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - start) / (end - start);
}

export function decimalYearToDate(year: number): Date {
  const y = Math.floor(year);
  const frac = year - y;
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return new Date(start + frac * (end - start));
}

export function formatMonthYear(year: number): string {
  const d = decimalYearToDate(year);
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function formatShareDate(year: number): string {
  const d = decimalYearToDate(year);
  const iso = d.toISOString().slice(0, 10);
  return iso;
}

export function yearsDelta(selected: number, reference: number): number {
  return selected - reference;
}

/** Linear interpolate RA/Dec on the track at `year` (RA unwrap for safety). */
export function interpolateTrack(
  points: TimeTrackSkyPoint[],
  year: number,
): TimeTrackSkyPoint | null {
  if (!points.length) return null;
  const y = clampYear(year);
  if (y <= points[0].decimal_year) return points[0];
  const last = points[points.length - 1];
  if (y >= last.decimal_year) return last;
  let i = 0;
  while (i < points.length - 1 && points[i + 1].decimal_year < y) i += 1;
  const a = points[i];
  const b = points[i + 1];
  const span = b.decimal_year - a.decimal_year || 1;
  const t = (y - a.decimal_year) / span;
  let dra = b.ra - a.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const ra = a.ra + t * dra;
  const dec = a.dec + t * (b.dec - a.dec);
  const offA = a.offset_from_catalog_arcsec ?? 0;
  const offB = b.offset_from_catalog_arcsec ?? 0;
  return {
    date_iso: formatShareDate(y),
    decimal_year: y,
    mjd: a.mjd + t * (b.mjd - a.mjd),
    ra,
    dec,
    offset_from_catalog_arcsec: offA + t * (offB - offA),
  };
}

export function onSkySeparationArcsec(
  ra0: number,
  dec0: number,
  ra1: number,
  dec1: number,
): number {
  const cosd = Math.max(Math.abs(Math.cos((dec0 * Math.PI) / 180)), 1e-6);
  let dra = (ra1 - ra0) * cosd * 3600;
  const ddec = (dec1 - dec0) * 3600;
  // unwrap RA difference roughly
  if (Math.abs((ra1 - ra0) * 3600) > 180 * 3600) {
    const alt = (((ra1 - ra0 + 540) % 360) - 180) * cosd * 3600;
    dra = alt;
  }
  return Math.hypot(dra, ddec);
}

export function arcsecToSpherexPixels(arcsec: number, scale = PIXEL_SCALE_ARCSEC): number {
  return arcsec / scale;
}

export function yearsPerMoonWidth(muArcsecYr: number): number | null {
  if (!(muArcsecYr > 0)) return null;
  return MOON_WIDTH_ARCSEC / muArcsecYr;
}
