/**
 * The images of the composer that have no runner path yet, kept in IndexedDB so an F5 does not
 * take them along.
 *
 * A pasted screenshot only exists in the browser until its upload lands, and an upload through the
 * runner takes a second or two — a reload in that window used to lose the picture, with the
 * clipboard long moved on. Each record holds the Blob itself (no base64: IndexedDB stores binary,
 * and its quota is a share of the disk, not the ~5 MB that sessionStorage gives ALL cards
 * together). A record lives from the paste until the chip gets its path, is removed, or is sent.
 *
 * Everything here fails soft: no IndexedDB (private mode, an old browser, jsdom), a blocked open,
 * a quota error — the composer works exactly as before, the picture just does not survive a reload.
 */

export interface PendingUpload {
  id: string;
  cardId: string;
  name: string;
  blob: Blob;
  /** The last attempt failed: comes back as an error chip with Retry, not as a new upload. */
  failed: boolean;
  /** Paste order, so the chips come back in the order they were on screen. */
  order: number;
}

const DB_NAME = "vibehub-composer";
const STORE = "pendingUploads";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("cardId", "cardId", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** One write/delete in its own transaction. Resolves when it is on disk (or failed: never rejects). */
async function write(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      run(tx.objectStore(STORE));
    } catch {
      resolve();
    }
  });
}

export function putPendingUpload(rec: PendingUpload): Promise<void> {
  return write((store) => store.put(rec));
}

export function deletePendingUpload(id: string): Promise<void> {
  return write((store) => store.delete(id));
}

export function markPendingUploadFailed(id: string, failed: boolean): Promise<void> {
  return write((store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const rec = req.result as PendingUpload | undefined;
      if (rec && rec.failed !== failed) store.put({ ...rec, failed });
    };
  });
}

/**
 * The card's pending uploads, oldest first. Only well-formed records: anything else in the store
 * (another version's shape, a half-written record) is skipped, never thrown. TOTAL.
 */
export async function listPendingUploads(cardId: string): Promise<PendingUpload[]> {
  const db = await openDb();
  if (!db) return [];
  return await new Promise<PendingUpload[]>((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).index("cardId").getAll(cardId);
      req.onsuccess = () => {
        const all: unknown[] = Array.isArray(req.result) ? req.result : [];
        resolve(all.filter(isPendingUpload).sort((a, b) => a.order - b.order));
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function isPendingUpload(v: unknown): v is PendingUpload {
  const r = v as Partial<PendingUpload> | null;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.cardId === "string" &&
    typeof r.name === "string" &&
    r.blob instanceof Blob &&
    typeof r.failed === "boolean" &&
    typeof r.order === "number"
  );
}

/** Tests only: drop the cached connection and every record. */
export async function resetPendingUploadsForTesting(): Promise<void> {
  await write((store) => store.clear());
  const db = dbPromise ? await dbPromise : null;
  db?.close();
  dbPromise = null;
}
