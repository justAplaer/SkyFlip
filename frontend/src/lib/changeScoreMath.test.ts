import { describe, expect, it } from "vitest";
import {
  biggestN,
  filterByRange,
  orderFrames,
  scoreExtents,
  scoreMagnitude,
} from "./changeScoreMath";
import type { ChangeScoreFrame } from "../types";

function frame(partial: Partial<ChangeScoreFrame> & { epoch_id: string; score: number | null }): ChangeScoreFrame {
  return {
    mjd: 60000,
    score_err: 1,
    score_unit: "S/N",
    masked_fraction: 0,
    n_aperture_pixels: 9,
    n_masked: 0,
    wavelength_mismatched: false,
    status: partial.score == null ? "not_computed" : "ok",
    ...partial,
  };
}

describe("changeScoreMath", () => {
  const frames = [
    frame({ epoch_id: "a", mjd: 1, score: 1 }),
    frame({ epoch_id: "b", mjd: 2, score: -5 }),
    frame({ epoch_id: "c", mjd: 3, score: 3 }),
    frame({ epoch_id: "d", mjd: 4, score: null, status: "not_computed" }),
  ];

  it("uses absolute magnitude", () => {
    expect(scoreMagnitude(frames[1])).toBe(5);
  });

  it("filters by range and drops not_computed", () => {
    const kept = filterByRange(frames, 2, 10);
    expect(kept.map((f) => f.epoch_id)).toEqual(["b", "c"]);
  });

  it("biggestN picks highest magnitudes", () => {
    const top = biggestN(frames, 2);
    expect(top.map((f) => f.epoch_id).sort()).toEqual(["b", "c"]);
  });

  it("orders by time or change", () => {
    const byChange = orderFrames(filterByRange(frames, 0, 10), "change");
    expect(byChange.map((f) => f.epoch_id)).toEqual(["a", "c", "b"]);
    const byTime = orderFrames(filterByRange(frames, 0, 10), "time");
    expect(byTime.map((f) => f.epoch_id)).toEqual(["a", "b", "c"]);
  });

  it("scoreExtents", () => {
    expect(scoreExtents(frames)).toEqual({ min: 1, max: 5 });
  });
});
