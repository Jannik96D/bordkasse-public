// @vitest-environment happy-dom
//
// Offline-Outbox (IndexedDB) — historisch bugträchtig (Idempotency-Key-
// Stabilität, Dedup, Draft-Round-Trip) und bis dato ungetestet. Läuft in
// happy-dom + fake-indexeddb, damit `indexedDB`, `window` und `CustomEvent`
// vorhanden sind.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  count,
  enqueue,
  get,
  listAll,
  remove,
  subscribeToChanges,
  type OutboxItem,
} from "@/lib/offline/outbox";

function resetDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("bordkasse");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function item(id: string, overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id,
    tripId: "t1",
    kind: "expense",
    formData: { trip_id: "t1" },
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("offline outbox", () => {
  it("enqueue + count + get liefern den Eintrag zurück", async () => {
    await enqueue(item("k1"));
    expect(await count()).toBe(1);
    const got = await get("k1");
    expect(got?.id).toBe("k1");
    expect(got?.tripId).toBe("t1");
    expect(got?.kind).toBe("expense");
  });

  it("listAll sortiert stabil nach createdAt (FIFO-Replay-Reihenfolge)", async () => {
    await enqueue(item("k-late", { createdAt: 200 }));
    await enqueue(item("k-early", { createdAt: 100 }));
    await enqueue(item("k-mid", { createdAt: 150 }));
    const all = await listAll();
    expect(all.map((i) => i.id)).toEqual(["k-early", "k-mid", "k-late"]);
  });

  it("gleiche id überschreibt statt zu duplizieren (Idempotenz/Draft-Edit)", async () => {
    await enqueue(item("dup", { formData: { trip_id: "t1", amount: "10" } }));
    await enqueue(item("dup", { formData: { trip_id: "t1", amount: "99" } }));
    // Ein Draft, der erneut gespeichert wird, behält denselben Key → kein Duplikat.
    expect(await count()).toBe(1);
    const got = await get("dup");
    expect(got?.formData.amount).toBe("99");
  });

  it("remove löscht den Eintrag", async () => {
    await enqueue(item("k1"));
    await enqueue(item("k2"));
    await remove("k1");
    expect(await count()).toBe(1);
    expect(await get("k1")).toBeUndefined();
    expect((await get("k2"))?.id).toBe("k2");
  });

  it("get auf unbekannte id → undefined", async () => {
    expect(await get("gibtsnicht")).toBeUndefined();
  });

  it("formData mit String-Arrays (participant_ids) bleibt erhalten", async () => {
    await enqueue(item("multi", { formData: { trip_id: "t1", participant_ids: ["a", "b", "c"] } }));
    const got = await get("multi");
    expect(got?.formData.participant_ids).toEqual(["a", "b", "c"]);
  });

  it("subscribeToChanges feuert bei enqueue und remove, nicht mehr nach unsub", async () => {
    const cb = vi.fn();
    const unsub = subscribeToChanges(cb);
    await enqueue(item("k1"));
    await remove("k1");
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    await enqueue(item("k2"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  // Fund 6, PR 5: Cross-Login-Schutz braucht personId auf dem OutboxItem.
  it("speichert und liest personId (Fund 6, PR 5)", async () => {
    await enqueue(item("with-owner", { personId: "person-a" }));
    const got = await get("with-owner");
    expect(got?.personId).toBe("person-a");
  });

  it("Altbestand ohne personId bleibt lesbar (Rückwärtskompatibilität)", async () => {
    await enqueue(item("legacy")); // kein personId gesetzt
    const got = await get("legacy");
    expect(got?.personId).toBeUndefined();
  });

  it("eine bei DB_VERSION 1 angelegte Datenbank bleibt nach dem Upgrade auf 2 lesbar", async () => {
    // Simuliert einen Client, der die Outbox VOR Fund 6 (personId, DB_VERSION 2)
    // befüllt hat. openDb() im Produktivcode nutzt inzwischen Version 2 — der
    // erste Aufruf danach muss onupgradeneeded durchlaufen, ohne den
    // bestehenden Eintrag zu verlieren.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("bordkasse", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("outbox", { keyPath: "id" });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("outbox", "readwrite");
        tx.objectStore("outbox").put(item("pre-v2"));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // Erster Zugriff über das Produktiv-Modul löst den Upgrade auf Version 2 aus.
    const pre = await get("pre-v2");
    expect(pre?.id).toBe("pre-v2");

    await enqueue(item("post-v2", { personId: "person-a" }));
    expect((await get("post-v2"))?.personId).toBe("person-a");
    expect(await count()).toBe(2);
  });
});
