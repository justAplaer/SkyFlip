import type {
  ChangeMetric,
  ChangeReference,
  ChangeScoresResponse,
  CutoutsResponse,
  HealthResponse,
  MoverCandidate,
  PredictedTrackResponse,
  ResolveResponse,
  SpectrumPoint,
} from "../types";

// Empty = same-origin `/api` via Vite proxy (survives CORS / API host flapping).
const API = import.meta.env.VITE_API_URL ?? "";
const DEFAULT_TIMEOUT_MS = 4000;

export type PixelInspectResult = {
  target_id: string;
  epoch_id: string;
  x_pix: number;
  y_pix: number;
  image_mjy_sr: number | null;
  bunit: string;
  flags_raw: number | null;
  flags_set: string[];
  variance: number | null;
  zodi_mjy_sr: number | null;
  central_wavelength_um: number | null;
  wavelength_note: string;
  variance_note: string;
  zodi_note: string;
  source: string;
  is_synthetic?: boolean;
  note?: string;
};

async function getJson<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, { signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`${r.status} ${text}`);
    }
    return (await r.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export function apiUrl(path: string): string {
  if (path.startsWith("/demo-data")) return path;
  if (path.startsWith("http")) return path;
  return `${API}${path}`;
}

export const api = {
  health: () => getJson<HealthResponse>("/api/health", 2000),
  resolve: (name: string) =>
    getJson<ResolveResponse>(`/api/resolve?name=${encodeURIComponent(name)}`),
  cutouts: (p: {
    ra: number;
    dec: number;
    fov: number;
    bandpass?: string;
    detector?: number;
    target?: string;
    target_name?: string;
    stack?: string;
    targeting_mode?: "fixed_sky" | "track_target";
    wavelength_tol_um?: number;
    median_subtract?: boolean;
    subtract_zodi?: boolean;
    view_mode?: "full_frame" | "target_crop";
  }) => {
    const q = new URLSearchParams({
      ra: String(p.ra),
      dec: String(p.dec),
      fov: String(p.fov),
    });
    if (p.bandpass) q.set("bandpass", p.bandpass);
    if (p.detector != null) q.set("detector", String(p.detector));
    if (p.target) q.set("target", p.target);
    if (p.target_name) q.set("target_name", p.target_name);
    if (p.stack) q.set("stack", p.stack);
    if (p.targeting_mode) q.set("targeting_mode", p.targeting_mode);
    if (p.wavelength_tol_um != null) q.set("wavelength_tol_um", String(p.wavelength_tol_um));
    if (p.median_subtract) q.set("median_subtract", "true");
    if (p.subtract_zodi) q.set("subtract_zodi", "true");
    if (p.view_mode) q.set("view_mode", p.view_mode);
    // Full-frame MEF is slow cold. Preset target_crop can fall back to demo fast.
    const timeout =
      p.view_mode === "full_frame" ? 90_000 : p.target ? 12_000 : 45_000;
    return getJson<CutoutsResponse>(`/api/cutouts?${q}`, timeout);
  },
  diff: (p: { ra: number; dec: number; fov: number; a: string; b: string; bandpass?: string }) => {
    const q = new URLSearchParams({
      ra: String(p.ra),
      dec: String(p.dec),
      fov: String(p.fov),
      a: p.a,
      b: p.b,
      bandpass: p.bandpass ?? "SPHEREx-D1",
    });
    return getJson<{
      image_url?: string | null;
      note?: string;
      source: string;
      wavelength_mismatched?: boolean;
      science_ok?: boolean;
    }>(`/api/diff?${q}`, 15000);
  },
  pixel: (p: { target: string; epoch_id: string; x: number; y: number }) => {
    const q = new URLSearchParams({
      target: p.target,
      epoch_id: p.epoch_id,
      x: String(p.x),
      y: String(p.y),
    });
    return getJson<PixelInspectResult>(`/api/pixel?${q}`, 4000);
  },
  predictedTrack: (ra: number, dec: number, name: string) =>
    getJson<PredictedTrackResponse>(
      `/api/predicted-track?ra=${ra}&dec=${dec}&name=${encodeURIComponent(name)}`,
      8000,
    ),
  movers: (ra: number, dec: number, fov: number) =>
    getJson<{ movers: MoverCandidate[]; source: string }>(`/api/movers?ra=${ra}&dec=${dec}&fov=${fov}`, 300000),
  spectrum: (ra: number, dec: number) =>
    getJson<{ points: SpectrumPoint[]; method_note: string; unit: string }>(
      `/api/spectrum?ra=${ra}&dec=${dec}`,
    ),
  scoreboard: () =>
    getJson<{ results: Record<string, unknown>; explanation: string; source: string }>(
      "/api/scoreboard",
    ),
  changeScores: (p: {
    ra: number;
    dec: number;
    radius: number;
    metric: ChangeMetric;
    reference: ChangeReference;
    target?: string;
  }) => {
    const q = new URLSearchParams({
      ra: String(p.ra),
      dec: String(p.dec),
      radius: String(p.radius),
      metric: p.metric,
      reference: p.reference,
    });
    if (p.target) q.set("target", p.target);
    return getJson<ChangeScoresResponse>(`/api/change-scores?${q}`, 8000);
  },
  postVote: async (candidate_id: string, vote: string) => {
    const q = new URLSearchParams({ candidate_id, vote });
    const r = await fetch(`${API}/api/votes?${q}`, { method: "POST" });
    return r.json();
  },
};
