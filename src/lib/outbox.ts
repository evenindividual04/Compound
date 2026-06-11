/**
 * Offline outbox: queues failed quick-entry payloads in IndexedDB.
 * When the network comes back (or on mount), replay() re-sends each pending
 * entry. The server deduplicates via idempotencyKey → no double-posts.
 * Raw IndexedDB, no external dependencies.
 */

const DB_NAME = "fin-outbox";
const DB_VERSION = 1;
const STORE = "queue";

export interface OutboxPayload {
  idempotencyKey: string;
  accountId: string;
  categoryId: string;
  amountAbs: string;
  date: string;
  description?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "idempotencyKey" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(payload: OutboxPayload): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(payload);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function replay(send: (p: OutboxPayload) => Promise<void>): Promise<void> {
  const db = await openDb();
  const items = await new Promise<OutboxPayload[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as OutboxPayload[]);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });

  for (const item of items) {
    try {
      await send(item);
      // Success — remove from queue
      const db2 = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db2.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).delete(item.idempotencyKey);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db2.close();
      });
    } catch {
      // Keep on failure — will retry next time online
    }
  }
}
