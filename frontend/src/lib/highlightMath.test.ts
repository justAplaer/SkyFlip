import { describe, expect, it } from "vitest";
import {
  defaultTanWcs,
  mapRectViaSky,
  normalizeRect,
  pixelToSky,
  rectToSkyCorners,
  rectValid,
  skyToPixel,
} from "./highlightMath";

describe("highlightMath", () => {
  const wcs = defaultTanWcs(133.8, -7.2, 29, 29);

  it("rejects zero-size and oversized rects", () => {
    expect(rectValid({ x0: 1, y0: 1, x1: 1, y1: 2 }, 29, 29).ok).toBe(false);
    expect(rectValid({ x0: 0, y0: 0, x1: 28, y1: 28 }, 29, 29).ok).toBe(false);
    expect(rectValid({ x0: 5, y0: 5, x1: 10, y1: 10 }, 29, 29).ok).toBe(true);
  });

  it("pixel↔sky round-trips within tolerance", () => {
    const p = { x: 10.5, y: 14.2 };
    const sky = pixelToSky(p.x, p.y, wcs);
    const back = skyToPixel(sky.ra, sky.dec, wcs);
    expect(back.x).toBeCloseTo(p.x, 5);
    expect(back.y).toBeCloseTo(p.y, 5);
  });

  it("mapRectViaSky identity on same WCS", () => {
    const r = normalizeRect({ x0: 4, y0: 6, x1: 12, y1: 15 });
    const mapped = mapRectViaSky(r, wcs, wcs);
    expect(mapped.x0).toBeCloseTo(r.x0, 4);
    expect(mapped.y0).toBeCloseTo(r.y0, 4);
    expect(mapped.x1).toBeCloseTo(r.x1, 4);
    expect(mapped.y1).toBeCloseTo(r.y1, 4);
  });

  it("rectToSkyCorners returns 4 corners", () => {
    expect(rectToSkyCorners({ x0: 1, y0: 2, x1: 8, y1: 9 }, wcs)).toHaveLength(4);
  });
});
