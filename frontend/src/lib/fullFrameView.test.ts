import { describe, expect, it } from "vitest";
import {
  clampScale,
  fitScaleFor,
  framesSignature,
  pushHistory,
  viewFromImageBox,
  zoomAround,
} from "./fullFrameView";

describe("fullFrameView", () => {
  it("fitScaleFor covers the detector in the CSS canvas", () => {
    const s = fitScaleFor(2040, 2040, 640);
    expect(s).toBeCloseTo((640 / 2040) * 0.95, 5);
  });

  it("clampScale respects fit floor and 16× ceiling", () => {
    const fit = 0.3;
    expect(clampScale(100, fit)).toBe(16);
    expect(clampScale(0.001, fit)).toBeCloseTo(fit * 0.5, 5);
  });

  it("zoomAround multiplies scale by factor", () => {
    const v = zoomAround({ centerRa: 1, centerDec: 2, scale: 1 }, 1.5, 0.3);
    expect(v.scale).toBeCloseTo(1.5, 5);
    expect(v.centerRa).toBe(1);
  });

  it("viewFromImageBox centers on the box mid-point", () => {
    const v = viewFromImageBox(100, 200, 300, 400, 0, 0, 0.3, 640, (x, y) => ({
      ra: x,
      dec: y,
    }));
    expect(v.centerRa).toBe(200);
    expect(v.centerDec).toBe(300);
    expect(v.scale).toBeGreaterThan(0.3);
  });

  it("pushHistory caps length", () => {
    let s: { centerRa: number; centerDec: number; scale: number }[] = [];
    for (let i = 0; i < 25; i++) {
      s = pushHistory(s, { centerRa: i, centerDec: 0, scale: 1 }, 20);
    }
    expect(s).toHaveLength(20);
    expect(s[0]?.centerRa).toBe(5);
  });

  it("framesSignature ignores array identity", () => {
    const a = [{ epoch_id: "a" }, { epoch_id: "b" }];
    const b = [{ epoch_id: "a" }, { epoch_id: "b" }];
    expect(framesSignature(a)).toBe(framesSignature(b));
  });
});
