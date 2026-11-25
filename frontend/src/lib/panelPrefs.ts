/** localStorage helpers for panel UI prefs (always try/catch). */

export function readJsonPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonPref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

export function shortenArchiveUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (path.length <= 48) return `${u.host}${path}`;
    return `${u.host}${path.slice(0, 22)}…${path.slice(-18)}`;
  } catch {
    if (url.length <= 56) return url;
    return `${url.slice(0, 28)}…${url.slice(-20)}`;
  }
}

/** Format ISO / MJD-ish times for the Data panel. */
export function formatEpochUtc(timeIso: string | undefined, mjd: number): string {
  if (timeIso && timeIso.length >= 10) {
    const d = new Date(timeIso.endsWith("Z") ? timeIso : `${timeIso}Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      });
    }
    return timeIso.slice(0, 19).replace("T", " ") + " UTC";
  }
  return `MJD ${mjd.toFixed(3)}`;
}

/** FOV across the displayed array (degrees), from shape × pixel scale. */
export function fovFromShape(
  shape: number[] | undefined,
  pixelScaleArcsec: number,
  viewMode: string | undefined,
  requestedFovDeg: number | undefined,
): { label: string; deg: number } {
  if (viewMode === "full_frame" && shape && shape.length >= 2) {
    const side = Math.max(Number(shape[0]), Number(shape[1]));
    const deg = (side * pixelScaleArcsec) / 3600;
    return { label: `~${deg.toFixed(2)}° across (full detector)`, deg };
  }
  const deg = requestedFovDeg ?? 0.2;
  return { label: `${deg.toFixed(3)}° (target crop)`, deg };
}
