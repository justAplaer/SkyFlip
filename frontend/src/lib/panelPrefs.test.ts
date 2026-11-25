import { describe, expect, it } from "vitest";
import { fovFromShape, formatEpochUtc, shortenArchiveUrl } from "./panelPrefs";

describe("panelPrefs helpers", () => {
  it("shortens archive URLs", () => {
    const u =
      "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b/5/level2_long.fits";
    const s = shortenArchiveUrl(u);
    expect(s).toContain("irsa.ipac.caltech.edu");
    expect(s.length).toBeLessThan(u.length);
    expect(s).toContain("…");
  });

  it("formats epochs", () => {
    const s = formatEpochUtc("2025-10-25T13:23:00", 60900);
    expect(s.toLowerCase()).toMatch(/2025|oct|utc|mjd/);
  });

  it("computes full-frame FOV from shape", () => {
    const f = fovFromShape([2040, 2040], 6.15, "full_frame", 0.2);
    expect(f.deg).toBeCloseTo((2040 * 6.15) / 3600, 3);
    expect(f.label).toMatch(/full detector/i);
  });

  it("keeps crop FOV for target_crop", () => {
    const f = fovFromShape([117, 117], 6.15, "target_crop", 0.2);
    expect(f.label).toMatch(/target crop/i);
  });
});
