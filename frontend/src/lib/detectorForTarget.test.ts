import { describe, expect, it } from "vitest";
import { detectorForTarget } from "./detectorForTarget";

describe("detectorForTarget", () => {
  it("uses D5 for cold brown dwarfs", () => {
    expect(detectorForTarget("wise0855")).toBe(5);
    expect(detectorForTarget("epsilon_indi_b")).toBe(5);
  });
  it("uses D1 for bright stars", () => {
    expect(detectorForTarget("barnards_star")).toBe(1);
    expect(detectorForTarget("rw_aurigae")).toBe(1);
    expect(detectorForTarget("r_draconis")).toBe(1);
  });
  it("defaults to D1", () => {
    expect(detectorForTarget("")).toBe(1);
    expect(detectorForTarget(null)).toBe(1);
  });
});
