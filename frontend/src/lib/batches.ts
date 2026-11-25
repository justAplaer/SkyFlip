import type { CutoutsResponse } from '../types';
const API = import.meta.env.VITE_API_URL ?? '';
export type SavedBatch = {
  batch_id: string; status: string; created_at: string; next_offset: number;
  image_count: number; warnings: string[]; error?: {message: string};
  data: CutoutsResponse;
  request: {ra: number; dec: number; fov: number; detector: number; view_mode: 'full_frame'|'target_crop'; name: string; target: string};
};
export type BatchChoice = {id: string; data: CutoutsResponse; ra: number; dec: number; fov: number; name: string; target: string; mode: 'full_frame'|'target_crop'; detector: number; offset: number};
export function batchChoice(b: SavedBatch): BatchChoice {
  const r = b.request;
  return {id:b.batch_id, data:b.data, ra:r.ra, dec:r.dec, fov:r.fov, name:r.name, target:r.target, mode:r.view_mode, detector:r.detector, offset:b.next_offset};
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, {method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)});
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message ?? JSON.stringify(data.detail));
  return data;
}
export const listBatches = () => request<{batches:SavedBatch[]}>('/api/batches');
export const getBatch = (id:string) => request<SavedBatch>(`/api/batches/${id}`);
export async function newBatch(params: SavedBatch['request'], progress: (s:string)=>void): Promise<SavedBatch> {
  let b = await request<SavedBatch>('/api/batches', {...params, idempotency_key:crypto.randomUUID()});
  const end = Date.now() + 20 * 60 * 1000;
  while (b.status === 'queued' || b.status === 'running') {
    progress(`${b.status === 'queued' ? 'Queued' : 'Processing'}: ${b.image_count}/10 images`);
    if (Date.now() > end) throw new Error('Batch is still processing on the server. Reload to check saved batches.');
    await new Promise(resolve=>setTimeout(resolve,1500));
    b = await getBatch(b.batch_id);
  }
  if (!b.data.frames.length) throw new Error(b.error?.message ?? b.warnings.join(' ') ?? 'No images available.');
  return b;
}
