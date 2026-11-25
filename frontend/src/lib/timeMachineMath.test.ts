import { describe, expect, it } from "vitest";
import {
  arcsecToSpherexPixels,
  clampYear,
  formatMonthYear,
  interpolateTrack,
  onSkySeparationArcsec,
  parseShareTime,
  yearsPerMoonWidth,
  type TimeTrackSkyPoint,
} from "./timeMachineMath";

const sample: TimeTrackSkyPoint[] = [
  {
    date_iso: "2016-01-01",
    decimal_year: 2016,
    mjd: 57388,
    ra: 269.45,
    dec: 4.69,
    offset_from_catalog_arcsec: 0,
  },
  {
    date_iso: "2026-01-01",
    decimal_year: 2026,
    mjd: 61041,
    ra: 269.4478,
    dec: 4.7188,
    offset_from_catalog_arcsec: 103.9,
  },
];

describe("timeMachineMath", () => {
  it("parses share ?t= ISO and decimal year", () => {
    expect(parseShareTime("2031-05-01")).toBeCloseTo(2031.329, 1);
    expect(parseShareTime("2019.5")).toBe(2019.5);
    expect(parseShareTime("")).toBeNull();
  });

  it("clamps to 2010–2035", () => {
    expect(clampYear(2000)).toBe(2010);
    expect(clampYear(2040)).toBe(2035);
  });

  it("interpolates track midway", () => {
    const mid = interpolateTrack(sample, 2021);
    expect(mid).not.toBeNull();
    expect(mid!.dec).toBeGreaterThan(sample[0].dec);
    expect(mid!.dec).toBeLessThan(sample[1].dec);
    expect(mid!.offset_from_catalog_arcsec).toBeCloseTo(51.95, 0);
  });

  it("formats month year", () => {
    expect(formatMonthYear(2019.2)).toMatch(/2019/);
  });

  it("converts arcsec to SPHEREx pixels", () => {
    expect(arcsecToSpherexPixels(12.3)).toBeCloseTo(2, 5);
  });

  it("moon-width years from μ", () => {
    expect(yearsPerMoonWidth(9)).toBeCloseTo(200, 5);
    expect(yearsPerMoonWidth(0)).toBeNull();
  });

  it("on-sky separation uses cos(dec)", () => {
    // 1° RA at dec=0 → 3600″; at dec=60 → 1800″
    expect(onSkySeparationArcsec(0, 0, 1, 0)).toBeCloseTo(3600, 0);
    expect(onSkySeparationArcsec(0, 60, 1, 60)).toBeCloseTo(1800, 0);
  });
});
