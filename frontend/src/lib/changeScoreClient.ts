import type { ChangeMetric, ChangeReference, ChangeScoresResponse } from "../types";
import { loadDemoChangeScores } from "./demoData";

const API = import.meta.env.VITE_API_URL ?? "";

const PRESET_TIMEOUT_MS = 8_000;
const LIVE_TIMEOUT_MS = 90_000;

type CacheKey = string;
const cache = new Map<CacheKey, ChangeScoresResponse>();

let activeCtrl: AbortController | null = null;

function keyOf(p: {
  ra: number;
  dec: number;
  radius: number;
  metric: ChangeMetric;
  reference: ChangeReference;
  target?: string;
  live?: boolean;
}): CacheKey {
  return [
    p.target ?? "",
    p.live ? "live" : "cache",
    p.ra.toFixed(6),
    p.dec.toFixed(6),
    p.radius,
    p.metric,
    p.reference,
  ].join("|");
}

/** Build the change-scores query string (exported for unit tests). */
export function buildChangeScoresQuery(p: {
  ra: number;
  dec: number;
  radius: number;
  metric: ChangeMetric;
  reference: ChangeReference;
  target?: string;
}): { url: string; live: boolean; timeoutMs: number } {
  const hasPreset = Boolean(p.target && p.target.trim());
  const live = !hasPreset;
  const q = new URLSearchParams({
    ra: String(p.ra),
    dec: String(p.dec),
    radius: String(p.radius),
    metric: p.metric,
    reference: p.reference,
  });
  if (hasPreset) q.set("target", p.target!.trim());
  if (live) q.set("live", "1");
  return {
    url: `${API}/api/change-scores?${q}`,
    live,
    timeoutMs: live ? LIVE_TIMEOUT_MS : PRESET_TIMEOUT_MS,
  };
}

async function fetchJson(url: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort);
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`${r.status} ${text}`);
    }
    return r.json();
  } finally {
    window.clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  }
}

export type ChangeScoreLoadOpts = {
  ra: number;
  dec: number;
  radius: number;
  metric: ChangeMetric;
  reference: ChangeReference;
  target?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
};

/**
 * Prefer demo cache for known presets (offline-safe).
 * For free-text / non-preset coordinates, send live=1 with a longer timeout.
 */
export async function loadChangeScores(p: ChangeScoreLoadOpts): Promise<ChangeScoresResponse> {
  const target = p.target?.trim() || undefined;
  const k = keyOf({ ...p, target, live: !target });
  const hit = cache.get(k);
  if (hit) return hit;

  if (target) {
    p.onProgress?.("Loading cached change scores…");
    const demo = await loadDemoChangeScores(target, {
      ra: p.ra,
      dec: p.dec,
      radius: p.radius,
      metric: p.metric,
      reference: p.reference,
    });
    if (demo) {
      cache.set(k, demo);
      return demo;
    }
  }

  const { url, live, timeoutMs } = buildChangeScoresQuery({ ...p, target });
  p.onProgress?.(
    live
      ? "Fetching live IRSA cutouts for change scores (may take up to ~90 s)…"
      : "Fetching change scores…",
  );

  // Cancel any prior in-flight live request
  if (activeCtrl) activeCtrl.abort();
  const ctrl = new AbortController();
  activeCtrl = ctrl;
  if (p.signal) {
    if (p.signal.aborted) ctrl.abort();
    else p.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  try {
    const data = (await fetchJson(url, timeoutMs, ctrl.signal)) as ChangeScoresResponse;
    if (data?.frames) {
      cache.set(k, data);
      return data;
    }
    throw new Error("not computed: empty change-scores response");
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error("not computed: cancelled");
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) {
      throw new Error("not computed: timed out waiting for live IRSA");
    }
    throw new Error(
      live
        ? `not computed: live change scores unavailable (${msg})`
        : `not computed: change scores unavailable (${msg})`,
    );
  } finally {
    if (activeCtrl === ctrl) activeCtrl = null;
  }
}

export function cancelChangeScores(): void {
  if (activeCtrl) {
    activeCtrl.abort();
    activeCtrl = null;
  }
}

export function clearChangeScoreCache(): void {
  cache.clear();
}
