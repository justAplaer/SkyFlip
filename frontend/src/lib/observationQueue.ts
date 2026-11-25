/** IndexedDB queue for observation submissions when backend is offline. */

const DB_NAME = "skyflip-obs-queue";
const STORE = "pending";
const MAX_ITEMS = 20;
const MAX_BYTES = 5 * 1024 * 1024;

export interface QueuedObservation {
  id: string;
  createdAt: string;
  payload: unknown;
  attempts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueObservation(payload: unknown): Promise<string> {
  const db = await openDb();
  const all = await listQueued(db);
  if (all.length >= MAX_ITEMS) {
    throw new Error("Offline queue full — try again when online.");
  }
  const raw = JSON.stringify(payload);
  if (raw.length > MAX_BYTES) {
    throw new Error("Report too large to queue offline.");
  }
  const id = crypto.randomUUID();
  const item: QueuedObservation = {
    id,
    createdAt: new Date().toISOString(),
    payload,
    attempts: 0,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

async function listQueued(db?: IDBDatabase): Promise<QueuedObservation[]> {
  const owned = !db;
  const d = db ?? (await openDb());
  const items = await new Promise<QueuedObservation[]>((resolve, reject) => {
    const tx = d.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedObservation[]);
    req.onerror = () => reject(req.error);
  });
  if (owned) d.close();
  return items;
}

export async function peekQueue(): Promise<QueuedObservation[]> {
  return listQueued();
}

export async function removeQueued(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function flushQueue(
  send: (payload: unknown) => Promise<{ ok: boolean }>,
): Promise<{ sent: number; failed: number }> {
  const items = await peekQueue();
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const r = await send(item.payload);
      if (r.ok) {
        await removeQueued(item.id);
        sent += 1;
      } else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
