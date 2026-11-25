import { describe, expect, it } from "vitest";
import { parseTanWcs, pixelToWorld, worldToPixel } from "./wcsSky";

describe("wcsSky alignment", () => {
  it("round-trips pixel↔world for a simple TAN WCS within 0.01 pix", () => {
    const wcs = parseTanWcs({
      CRPIX1: 1020.5,
      CRPIX2: 1020.5,
      CRVAL1: 133.8,
      CRVAL2: -7.25,
      CDELT1: -6.15 / 3600,
      CDELT2: 6.15 / 3600,
      NAXIS1: 2040,
      NAXIS2: 2040,
    });
    expect(wcs).not.toBeNull();
    if (!wcs) return;
    const { x, y } = worldToPixel(wcs, 133.8, -7.25);
    expect(x).toBeCloseTo(1019.5, 3);
    expect(y).toBeCloseTo(1019.5, 3);
    const sky = pixelToWorld(wcs, x, y);
    expect(sky.ra).toBeCloseTo(133.8, 5);
    expect(sky.dec).toBeCloseTo(-7.25, 5);
    const back = worldToPixel(wcs, sky.ra, sky.dec);
    expect(Math.hypot(back.x - x, back.y - y)).toBeLessThan(0.01);
  });

  it("respects 0-based pixels vs 1-based FITS CRPIX", () => {
    const wcs = parseTanWcs({
      CRPIX1: 1,
      CRPIX2: 1,
      CRVAL1: 10,
      CRVAL2: 20,
      CDELT1: -6.15 / 3600,
      CDELT2: 6.15 / 3600,
      NAXIS1: 100,
      NAXIS2: 100,
    });
    expect(wcs).not.toBeNull();
    if (!wcs) return;
    // CRPIX (1,1) FITS → 0-indexed pixel (0,0)
    const sky = pixelToWorld(wcs, 0, 0);
    expect(sky.ra).toBeCloseTo(10, 5);
    expect(sky.dec).toBeCloseTo(20, 5);
  });

  it("maps the same sky to different pixels on two pointings", () => {
    const a = parseTanWcs({
      CRPIX1: 1000,
      CRPIX2: 1000,
      CRVAL1: 133.8,
      CRVAL2: -7.25,
      CDELT1: -6.15 / 3600,
      CDELT2: 6.15 / 3600,
      NAXIS1: 2040,
      NAXIS2: 2040,
    });
    const b = parseTanWcs({
      CRPIX1: 1000,
      CRPIX2: 1000,
      CRVAL1: 133.85,
      CRVAL2: -7.25,
      CDELT1: -6.15 / 3600,
      CDELT2: 6.15 / 3600,
      NAXIS1: 2040,
      NAXIS2: 2040,
    });
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    const pa = worldToPixel(a, 133.8, -7.25);
    const pb = worldToPixel(b, 133.8, -7.25);
    expect(Math.abs(pa.x - pb.x)).toBeGreaterThan(1);
  });
});
