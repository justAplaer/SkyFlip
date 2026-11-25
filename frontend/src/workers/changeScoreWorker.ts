/**
 * Web Worker: fetch change scores off the main thread so the UI never freezes.
 * Offline: caller may post a static `/demo-data/...` path via `demoUrl`.
 */
export type WorkerRequest = {
  id: number;
  apiUrl?: string;
  demoUrl?: string;
};

export type WorkerResponse = {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, apiUrl, demoUrl } = ev.data;
  try {
    const url = apiUrl || demoUrl;
    if (!url) throw new Error("no url");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    const msg: WorkerResponse = { id, ok: true, data };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    const msg: WorkerResponse = {
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(msg);
  }
};
