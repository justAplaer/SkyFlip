import { describe, expect, it } from "vitest";
import {
  CACHE_POSITION_TOL_DEG,
  manifestCenterMatch,
  positionsMatch,
} from "./skyMatch";

describe("positionsMatch (Bug 1)", () => {
  it("accepts the same point", () => {
    expect(positionsMatch(269.45, 4.69, 269.45, 4.69)).toBe(true);
  });

  it("rejects Barnard's vs WISE 0855", () => {
    expect(positionsMatch(269.45, 4.69, 133.795, -7.245)).toBe(false);
  });

  it("uses the documented tolerance", () => {
    expect(positionsMatch(0, 0, 0.05, 0, CACHE_POSITION_TOL_DEG)).toBe(false);
    expect(positionsMatch(0, 0, 0.01, 0)).toBe(true);
  });
});

describe("manifestCenterMatch (high-PM packs)", () => {
  it("matches catalog epoch even when cutout CRVAL is mid-span", () => {
    // Barnard's: Gaia J2016 vs SPHEREx mid-span (~0.029° in Dec > 0.02 tol)
    const man = {
      ra: 269.4498066114646,
      dec: 4.72261620254166,
      catalog_ra: 269.4520769586187,
      catalog_dec: 4.69336496657667,
    };
    expect(positionsMatch(man.catalog_ra, man.catalog_dec, man.ra, man.dec)).toBe(
      false,
    );
    expect(
      manifestCenterMatch(man.catalog_ra, man.catalog_dec, man),
    ).toBe(true);
    expect(manifestCenterMatch(man.ra, man.dec, man)).toBe(true);
  });

  it("still rejects a different field", () => {
    expect(
      manifestCenterMatch(133.795, -7.245, {
        ra: 269.45,
        dec: 4.72,
        catalog_ra: 269.452,
        catalog_dec: 4.693,
      }),
    ).toBe(false);
  });
});
