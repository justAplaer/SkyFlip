import { describe, expect, it } from "vitest";
import { NEAR_TARGET_TOL_DEG, snapToKnownTarget } from "./nearTarget";
import { TEST_TARGETS } from "../types";

describe("snapToKnownTarget", () => {
  it("snaps exact demo centers", () => {
    for (const t of TEST_TARGETS) {
      expect(snapToKnownTarget(t.ra, t.dec)?.id).toBe(t.id);
    }
  });

  it("snaps within 30 arcsec", () => {
    const t = TEST_TARGETS.find((x) => x.id === "wise0855")!;
    const d = 20 / 3600;
    expect(snapToKnownTarget(t.ra + d, t.dec)?.id).toBe("wise0855");
  });

  it("does not snap beyond 30 arcsec", () => {
    const t = TEST_TARGETS.find((x) => x.id === "wise0855")!;
    const d = 45 / 3600;
    expect(snapToKnownTarget(t.ra + d, t.dec, TEST_TARGETS, NEAR_TARGET_TOL_DEG)).toBeNull();
  });
});
