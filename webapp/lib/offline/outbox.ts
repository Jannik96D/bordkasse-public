/**
 * IndexedDB-Outbox für Buchungen, die offline erfasst wurden.
 *
 * Wenn der User auf "Speichern" klickt und kein Netz da ist, schreibt das
 * Form ein OutboxItem hierher. Beim Online-Werden wird die Outbox vom
 * Sync-Mechanismus abgearbeitet — jeder Eintrag wird mit dem ursprünglichen
 * idempotency_key wieder an die Server Action geschickt. Falls der Server
 * den Key schon kennt, antwortet er mit Redirect (siehe lib/actions/transactions.ts);
 * Duplikate sind also ausgeschlossen.
 *
 * API ist intentional schmal: enqueue/list/remove. Kein Retry-Counter, kein
 * Backoff — der Sync-Caller kümmert sich darum.
 */

const DB_NAME = "bordkasse";
const DB_VERSION = 1;
const STORE = "outbox";

export type OutboxItem = {
  id: string; // idempotency_key — gleichzeitig Primary Key
  tripId: string;
  kind: "expense" | "credit";
  formData: Record<string, string | string[]>;
  createdAt: number;
};

/** Ein formData-Feld als String (leer bei Array/undefined). Geteilt von den
 *  Komponenten, die `OutboxItem.formData` dekodieren (Pending-Karten + Draft-
 *  Editor), damit ihre Dekodierung nicht auseinanderdriftet. */
export function fieldStr(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** Ein formData-Feld als Number (deutsches Komma → Punkt). Leer/ungültig → 0. */
export function fieldNum(v: string | string[] | undefined): number {
  const s = fieldStr(v);
  if (s === "") return 0;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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

function txPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(item: OutboxItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await txPromise(tx.objectStore(STORE).put(item));
  db.close();
  notifyChange();
}

export async function get(id: string): Promise<OutboxItem | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const item = await txPromise(
    tx.objectStore(STORE).get(id) as IDBRequest<OutboxItem | undefined>,
  );
  db.close();
  return item;
}

export async function listAll(): Promise<OutboxItem[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const items = await txPromise(tx.objectStore(STORE).getAll() as IDBRequest<OutboxItem[]>);
  db.close();
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function remove(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await txPromise(tx.objectStore(STORE).delete(id));
  db.close();
  notifyChange();
}

export async function count(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const n = await txPromise(tx.objectStore(STORE).count());
  db.close();
  return n;
}

// Same-Tab-Notification für Banner-Refresh.
const CHANGE_EVENT = "bordkasse:outbox:change";

function notifyChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeToChanges(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}
