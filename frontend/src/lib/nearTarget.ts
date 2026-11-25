import { TEST_TARGETS, type TestTarget } from "../types";
import { positionsMatch } from "./skyMatch";

/** 30 arcseconds — snap typed coords to a curated demo target. */
export const NEAR_TARGET_TOL_DEG = 30 / 3600;

/**
 * If (ra, dec) is within 30″ of a curated target center, return that target.
 * Centers are the SPHEREx-era demo CRVAL coords (same as TargetButtons).
 */
export function snapToKnownTarget(
  ra: number,
  dec: number,
  targets: TestTarget[] = TEST_TARGETS,
  tolDeg: number = NEAR_TARGET_TOL_DEG,
): TestTarget | null {
  for (const t of targets) {
    if (t.ra == null || t.dec == null) continue;
    if (positionsMatch(ra, dec, t.ra, t.dec, tolDeg)) return t;
  }
  return null;
}
