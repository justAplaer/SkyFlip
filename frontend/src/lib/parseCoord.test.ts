import { describe, expect, it } from "vitest";
import {
  formatCoordBox,
  galacticToIcrs,
  normalizeRa,
  parseCoord,
  validateSkyCoord,
} from "./parseCoord";

describe("parseCoord", () => {
  it("rejects invalid sexagesimal components and trailing text", () => {
    expect(parseCoord("08:60:10 -07:14:42")).toBeNull();
    expect(parseCoord("24:00:00 +00:00:00")).toBeNull();
    expect(parseCoord("08h55m10s -90d01m00s")).toBeNull();
    expect(parseCoord("08h55m10s -7d14m42s garbage")).toBeNull();
    expect(parseCoord("08h55m10.831s -7d14m42.53s")?.ra).toBeCloseTo(133.795129, 5);
  });

  it("parses official WISE 0855 colon string", () => {
    const p = parseCoord("08:55:10.831 -07:14:42.53");
    expect(p).not.toBeNull();
    expect(p!.ra).toBeCloseTo(133.79512917, 5);
    expect(p!.dec).toBeCloseTo(-7.24514722, 5);
    expect(p!.frame).toBe("icrs");
  });

  it("parses degree pair with comma", () => {
    const p = parseCoord("133.795, -7.245");
    expect(p?.ra).toBeCloseTo(133.795, 3);
    expect(p?.dec).toBeCloseTo(-7.245, 3);
  });

  it("parses degree pair with space only", () => {
    const p = parseCoord("133.8 -7.25");
    expect(p?.ra).toBeCloseTo(133.8, 3);
    expect(p?.dec).toBeCloseTo(-7.25, 3);
  });

  it("parses sexagesimal hms/dms", () => {
    const p = parseCoord("08h55m10.831s -7d14m42.53s");
    expect(p).not.toBeNull();
    expect(p!.ra).toBeCloseTo(133.79512917, 4);
    expect(p!.dec).toBeCloseTo(-7.24514722, 4);
  });

  it("parses galactic gal: l b", () => {
    const p = parseCoord("gal: 31.0 14.0");
    expect(p).not.toBeNull();
    expect(p!.frame).toBe("galactic");
    expect(Number.isFinite(p!.ra)).toBe(true);
    expect(p!.dec).toBeGreaterThanOrEqual(-90);
    expect(p!.dec).toBeLessThanOrEqual(90);
    const round = galacticToIcrs(31.0, 14.0);
    expect(p!.ra).toBeCloseTo(round.ra, 5);
    expect(p!.dec).toBeCloseTo(round.dec, 5);
  });

  it("returns null for object names (resolve path)", () => {
    expect(parseCoord("Barnard's Star")).toBeNull();
    expect(parseCoord("WISE 0855-0714")).toBeNull();
  });

  it("handles RA 0 / 360 edge and negative zero Dec", () => {
    const a = parseCoord("0, 0");
    expect(a?.ra).toBe(0);
    expect(a?.dec).toBe(0);
    const b = parseCoord("360, -0");
    expect(b).not.toBeNull();
    expect(normalizeRa(b!.ra)).toBeCloseTo(0, 8);
  });
});

describe("validateSkyCoord / normalizeRa", () => {
  it("rejects Dec outside ±90", () => {
    expect(validateSkyCoord(10, 91)).toMatch(/Dec must be between/);
    expect(validateSkyCoord(10, -90.1)).toMatch(/Dec must be between/);
  });

  it("accepts poles and wraps RA", () => {
    expect(validateSkyCoord(0, 90)).toBeNull();
    expect(validateSkyCoord(370, -90)).toBeNull();
    expect(normalizeRa(370)).toBeCloseTo(10, 8);
    expect(normalizeRa(-10)).toBeCloseTo(350, 8);
    expect(normalizeRa(0)).toBe(0);
    expect(normalizeRa(360)).toBeCloseTo(0, 8);
  });

  it("rejects non-finite", () => {
    expect(validateSkyCoord(Number.NaN, 0)).toMatch(/finite/);
    expect(validateSkyCoord(0, Number.POSITIVE_INFINITY)).toMatch(/finite/);
  });
});

describe("formatCoordBox", () => {
  it("formats a stable box string", () => {
    expect(formatCoordBox(133.76047590770844, -7.24216033045264)).toMatch(
      /133\.760476,\s*-7\.242160/,
    );
  });
});
