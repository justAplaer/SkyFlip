import type { ChangeScoreFrame, ChangeSortMode, TrailPoint } from "../types";

/** Absolute change magnitude for filtering / sorting (null → not sortable). */
export function scoreMagnitude(f: ChangeScoreFrame): number | null {
  if (f.status !== "ok" || f.score == null || !Number.isFinite(f.score)) return null;
  return Math.abs(f.score);
}

export function filterByRange(
  frames: ChangeScoreFrame[],
  lo: number,
  hi: number,
): ChangeScoreFrame[] {
  return frames.filter((f) => {
    const m = scoreMagnitude(f);
    if (m == null) return false;
    return m >= lo && m <= hi;
  });
}

export function biggestN(frames: ChangeScoreFrame[], n: number): ChangeScoreFrame[] {
  const ok = frames
    .map((f) => ({ f, m: scoreMagnitude(f) }))
    .filter((x): x is { f: ChangeScoreFrame; m: number } => x.m != null)
    .sort((a, b) => b.m - a.m)
    .slice(0, Math.max(0, n))
    .map((x) => x.f);
  return ok;
}

export function orderFrames(
  frames: ChangeScoreFrame[],
  mode: ChangeSortMode,
): ChangeScoreFrame[] {
  const copy = [...frames];
  if (mode === "time") {
    copy.sort((a, b) => a.mjd - b.mjd);
  } else {
    copy.sort((a, b) => (scoreMagnitude(a) ?? -1) - (scoreMagnitude(b) ?? -1));
  }
  return copy;
}

export function trailFromScores(frames: ChangeScoreFrame[]): TrailPoint[] {
  const pts = frames
    .filter(
      (f) =>
        f.centroid_x != null &&
        f.centroid_y != null &&
        Number.isFinite(f.centroid_x) &&
        Number.isFinite(f.centroid_y),
    )
    .sort((a, b) => a.mjd - b.mjd);
  return pts.map((f, i) => ({
    epoch_id: f.epoch_id,
    mjd: f.mjd,
    x: f.centroid_x as number,
    y: f.centroid_y as number,
    score: f.score,
    index: i + 1,
  }));
}

/** Colorblind-safe blue→yellow ramp (Wong / Tol). */
export function trailColor(t: number): string {
  const u = Math.min(1, Math.max(0, t));
  const r = Math.round(0 + u * 240);
  const g = Math.round(90 + u * 110);
  const b = Math.round(180 - u * 140);
  return `rgb(${r},${g},${b})`;
}

export function scoreExtents(frames: ChangeScoreFrame[]): { min: number; max: number } {
  const vals = frames.map(scoreMagnitude).filter((v): v is number => v != null);
  if (!vals.length) return { min: 0, max: 1 };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}
