import { describe, expect, it } from "vitest";
import {
  ARCHIVE_LOOK,
  BAD_FLAG_MASK,
  FLAG_BITS,
  flaggedPixelLegend,
  isBadFlag,
  percentileClip,
  stretchToRgba,
} from "./stretch";

describe("stretch flags + clip (archive look)", () => {
  it("does not treat SOURCE as a bad flag", () => {
    expect(isBadFlag(1 << FLAG_BITS.SOURCE)).toBe(false);
    expect(isBadFlag(1 << FLAG_BITS.FULLSAMPLE)).toBe(false);
    expect(isBadFlag(1 << FLAG_BITS.OVERFLOW)).toBe(true);
    expect(isBadFlag(1 << FLAG_BITS.HALO)).toBe(true);
    expect((BAD_FLAG_MASK & (1 << FLAG_BITS.SOURCE)) === 0).toBe(true);
  });

  it("percentileClip defaults cover 1–99.5 range", () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => i);
    const [lo, hi] = percentileClip(data, 1, 99.5);
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(999);
  });

  it("default (showFlags off): NaN and OVERFLOW are plain black, not hatch", () => {
    const w = 2;
    const h = 2;
    const data = new Float32Array([10, 20, Number.NaN, 40]);
    const flags = new Uint16Array([0, 0, 0, 1 << FLAG_BITS.OVERFLOW]);
    const img = stretchToRgba(data, w, h, {
      mode: "asinh",
      vmin: 10,
      vmax: 40,
      flags,
      colormap: "gray",
      showFlags: false,
    });
    // NaN → black
    expect(img.data[8]).toBe(0);
    expect(img.data[9]).toBe(0);
    expect(img.data[10]).toBe(0);
    // OVERFLOW → black (archive saturated core)
    expect(img.data[12]).toBe(0);
    expect(img.data[13]).toBe(0);
    expect(img.data[14]).toBe(0);
    // Finite unflagged → grayscale channel equality
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[0]).toBe(img.data[2]);
  });

  it("showFlags on: OVERFLOW gets magenta hatch; SOURCE stays gray", () => {
    const w = 2;
    const h = 2;
    const data = new Float32Array([10, 20, 30, 40]);
    const flags = new Uint16Array([1 << FLAG_BITS.SOURCE, 0, 0, 1 << FLAG_BITS.OVERFLOW]);
    const img = stretchToRgba(data, w, h, {
      mode: "asinh",
      vmin: 10,
      vmax: 40,
      flags,
      colormap: "gray",
      showFlags: true,
    });
    // pixel 0: SOURCE → stretched gray, not hatch magenta
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[2]).toBe(img.data[1]);
    // pixel 3: OVERFLOW → hatch (R > G)
    expect(img.data[12]).toBeGreaterThan(img.data[13]);
  });

  it("archive look preset is grayscale asinh nearest no flags", () => {
    expect(ARCHIVE_LOOK).toEqual({
      stretch: "asinh",
      clipLo: 1,
      clipHi: 99.5,
      cmap: "gray",
      interp: false,
      showFlags: false,
    });
  });

  it("flaggedPixelLegend lists contamination bits with indices", () => {
    const legend = flaggedPixelLegend();
    expect(legend.some((x) => x.name === "OVERFLOW" && x.bit === 1)).toBe(true);
    expect(legend.some((x) => x.name === "BLOOM" && x.bit === 26)).toBe(true);
    expect(legend.some((x) => x.name === "SOURCE")).toBe(false);
  });
});
