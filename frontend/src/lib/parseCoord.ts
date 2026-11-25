/**
 * Sky coordinate parsing for SearchBar.
 * Supports decimal degrees, colon/letter sexagesimal, and galactic "gal:" input.
 */

export type ParsedSky = { ra: number; dec: number; frame: "icrs" | "galactic" };

/** Wrap RA into [0, 360). */
export function normalizeRa(ra: number): number {
  let r = ra % 360;
  if (r < 0) r += 360;
  return r;
}

/** Return a friendly error, or null if OK. Dec must be in [−90, 90]; RA finite. */
export function validateSkyCoord(ra: number, dec: number): string | null {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    return "Coordinates must be finite numbers.";
  }
  if (dec < -90 || dec > 90) {
    return "Dec must be between −90° and +90°.";
  }
  return null;
}

/** Galactic (l, b) degrees → ICRS RA/Dec (spherical trig; sufficient for search). */
export function galacticToIcrs(lDeg: number, bDeg: number): { ra: number; dec: number } {
  // North galactic pole in ICRS (J2000): RA=192.85948°, Dec=27.12825°; θ=122.93192°
  const lNCP = (122.93192 * Math.PI) / 180;
  const aNGP = (192.85948 * Math.PI) / 180;
  const dNGP = (27.12825 * Math.PI) / 180;
  const l = (lDeg * Math.PI) / 180;
  const b = (bDeg * Math.PI) / 180;
  const sinDec =
    Math.sin(b) * Math.sin(dNGP) + Math.cos(b) * Math.cos(dNGP) * Math.cos(lNCP - l);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const y = Math.cos(b) * Math.sin(lNCP - l);
  const x =
    Math.sin(b) * Math.cos(dNGP) - Math.cos(b) * Math.sin(dNGP) * Math.cos(lNCP - l);
  const ra = aNGP + Math.atan2(y, x);
  return {
    ra: normalizeRa((ra * 180) / Math.PI),
    dec: (dec * 180) / Math.PI,
  };
}

function parseDegreePair(t: string): { ra: number; dec: number } | null {
  const m = t.match(/^([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { ra: Number(m[1]), dec: Number(m[2]) };
}

function parseColonSexagesimal(t: string): { ra: number; dec: number } | null {
  const colon = t.match(
    /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)\s+([+-]?\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/,
  );
  if (!colon) return null;
  if (Number(colon[1]) >= 24 || Number(colon[2]) >= 60 || Number(colon[3]) >= 60 || Number(colon[5]) >= 60 || Number(colon[6]) >= 60 || Math.abs(Number(colon[4])) > 90 || (Math.abs(Number(colon[4])) === 90 && (Number(colon[5]) !== 0 || Number(colon[6]) !== 0))) return null;
  const ra = 15 * (Number(colon[1]) + Number(colon[2]) / 60 + Number(colon[3]) / 3600);
  const sign = colon[4].startsWith("-") ? -1 : 1;
  const dec =
    sign * (Math.abs(Number(colon[4])) + Number(colon[5]) / 60 + Number(colon[6]) / 3600);
  return { ra, dec };
}

function parseLetterSexagesimal(t: string): { ra: number; dec: number } | null {
  const sex = t.match(
    /^(\d+)[h\s]+(\d+)[m\s]+(\d+(?:\.\d+)?)[s]?\s+([+-]?\d+)[d°\s]+(\d+)[m'\s]+(\d+(?:\.\d+)?)[s"″]?\s*$/i,
  );
  if (!sex) return null;
  if (Number(sex[1]) >= 24 || Number(sex[2]) >= 60 || Number(sex[3]) >= 60 || Number(sex[5]) >= 60 || Number(sex[6]) >= 60 || Math.abs(Number(sex[4])) > 90 || (Math.abs(Number(sex[4])) === 90 && (Number(sex[5]) !== 0 || Number(sex[6]) !== 0))) return null;
  const ra = 15 * (Number(sex[1]) + Number(sex[2]) / 60 + Number(sex[3]) / 3600);
  const sign = sex[4].startsWith("-") ? -1 : 1;
  const dec =
    sign * (Math.abs(Number(sex[4])) + Number(sex[5]) / 60 + Number(sex[6]) / 3600);
  return { ra, dec };
}

/**
 * Parse a coordinate string. Returns null if it looks like a name (caller should resolve).
 * Throws nothing — invalid numeric shapes still return null so names can fall through.
 */
export function parseCoord(text: string): ParsedSky | null {
  const raw = text.trim();
  if (!raw) return null;

  // Galactic: "gal: 31.0 14.0" or "gal:31,14"
  const gal = raw.match(/^gal\s*:\s*(.+)$/i);
  if (gal) {
    const pair = parseDegreePair(gal[1].trim());
    if (!pair) return null;
    if (pair.dec < -90 || pair.dec > 90) return null;
    const icrs = galacticToIcrs(normalizeRa(pair.ra), pair.dec);
    return { ra: icrs.ra, dec: icrs.dec, frame: "galactic" };
  }

  const deg = parseDegreePair(raw);
  if (deg) return { ra: deg.ra, dec: deg.dec, frame: "icrs" };

  const colon = parseColonSexagesimal(raw);
  if (colon) return { ra: colon.ra, dec: colon.dec, frame: "icrs" };

  const letter = parseLetterSexagesimal(raw);
  if (letter) return { ra: letter.ra, dec: letter.dec, frame: "icrs" };

  return null;
}

/** Format ICRS for the search box (two decimals). */
export function formatCoordBox(ra: number, dec: number): string {
  const r = normalizeRa(ra);
  const dSign = dec < 0 || Object.is(dec, -0) ? "-" : "";
  const dAbs = Math.abs(dec);
  return `${r.toFixed(6)}, ${dSign}${dAbs.toFixed(6)}`;
}
