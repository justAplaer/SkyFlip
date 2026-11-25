import type { ObservationDraft } from "./observationTypes";

const KEY = "skyflip-observation-draft-v1";

export function saveDraft(draft: ObservationDraft): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* quota */
  }
}

export function loadDraft(): ObservationDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ObservationDraft;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function newIdempotencyKey(): string {
  return `obs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
