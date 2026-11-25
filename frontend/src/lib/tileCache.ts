import { apiUrl } from "./api";

export type TileKey = string;

export function tileKey(
  obsId: string,
  detector: number,
  level: number,
  ty: number,
  tx: number,
  kind: "image" | "flags",
  subtractZodi: boolean,
): TileKey {
  return `${obsId}|D${detector}|L${level}|${ty}|${tx}|${kind}|z${subtractZodi ? 1 : 0}`;
}

interface LruEntry {
  key: TileKey;
  data: Float32Array | Int32Array;
  ny: number;
  nx: number;
}

/** Simple LRU for decoded float/flag tiles. */
export class TileLru {
  private map = new Map<TileKey, LruEntry>();
  private capacity: number;
  constructor(capacity = 64) {
    this.capacity = capacity;
  }

  get(key: TileKey): LruEntry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  set(entry: LruEntry): void {
    if (this.map.has(entry.key)) this.map.delete(entry.key);
    this.map.set(entry.key, entry);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next().value as TileKey | undefined;
      if (first == null) break;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const inflight = new Map<TileKey, Promise<LruEntry>>();

export async function fetchImageTile(
  cache: TileLru,
  opts: {
    obsId: string;
    detector: number;
    level: number;
    ty: number;
    tx: number;
    subtractZodi: boolean;
    expectNy: number;
    expectNx: number;
  },
): Promise<LruEntry> {
  const key = tileKey(
    opts.obsId,
    opts.detector,
    opts.level,
    opts.ty,
    opts.tx,
    "image",
    opts.subtractZodi,
  );
  const hit = cache.get(key);
  if (hit) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const q = opts.subtractZodi ? "?subtract_zodi=true" : "?subtract_zodi=false";
      const url = apiUrl(
        `/api/frame/${encodeURIComponent(opts.obsId)}/${opts.detector}/tile/${opts.level}/${opts.ty}/${opts.tx}${q}`,
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`tile ${r.status}`);
      const buf = await r.arrayBuffer();
      const data = new Float32Array(buf);
      const entry: LruEntry = {
        key,
        data,
        ny: opts.expectNy,
        nx: opts.expectNx,
      };
      // Edge tiles may be smaller than tile_size²
      const n = data.length;
      const nx = opts.expectNx;
      const ny = Math.max(1, Math.floor(n / Math.max(nx, 1)));
      entry.nx = nx;
      entry.ny = ny;
      if (nx * ny !== n) {
        // Infer square-ish edge
        const side = Math.round(Math.sqrt(n));
        entry.nx = side;
        entry.ny = Math.floor(n / side) || 1;
      }
      cache.set(entry);
      return entry;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export async function fetchFlagsTile(
  cache: TileLru,
  opts: {
    obsId: string;
    detector: number;
    level: number;
    ty: number;
    tx: number;
    subtractZodi: boolean;
    expectNy: number;
    expectNx: number;
  },
): Promise<LruEntry> {
  const key = tileKey(
    opts.obsId,
    opts.detector,
    opts.level,
    opts.ty,
    opts.tx,
    "flags",
    opts.subtractZodi,
  );
  const hit = cache.get(key);
  if (hit) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const q = opts.subtractZodi ? "?subtract_zodi=true" : "?subtract_zodi=false";
      const url = apiUrl(
        `/api/frame/${encodeURIComponent(opts.obsId)}/${opts.detector}/flags/${opts.level}/${opts.ty}/${opts.tx}${q}`,
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`flags ${r.status}`);
      const buf = await r.arrayBuffer();
      const data = new Int32Array(buf);
      const n = data.length;
      const side = Math.round(Math.sqrt(n));
      const entry: LruEntry = {
        key,
        data,
        ny: side,
        nx: Math.floor(n / side) || 1,
      };
      cache.set(entry);
      return entry;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Choose pyramid level so one source pixel ≈ screenScale CSS pixels. */
export function chooseLevel(
  nLevels: number,
  screenPerNative: number,
): number {
  // screenPerNative = cssPixels / nativePixels. When zoomed out, use higher level.
  if (screenPerNative >= 1) return 0;
  let level = 0;
  let scale = screenPerNative;
  while (level < nLevels - 1 && scale < 0.5) {
    level += 1;
    scale *= 2;
  }
  return level;
}
