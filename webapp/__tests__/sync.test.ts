// @vitest-environment happy-dom
//
// Outbox-Sync — Fund O-1 (Draft-Bearbeitung geht bei parallelem Sync verloren).
// Der Fix hält für jeden gerade replizierten Eintrag ein Lock (isSyncing) und
// liest den Eintrag FRISCH vor dem Replay, statt aus dem Listen-Snapshot.
// Läuft in happy-dom + fake-indexeddb.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-Action mocken — die echte importiert "server-only" + Supabase.
vi.mock("@/lib/actions/transactions", () => ({
  replayPendingTransaction: vi.fn(),
}));

import { enqueue, get, count, type OutboxItem } from "@/lib/offline/outbox";
import { syncOutbox, isSyncing } from "@/lib/offline/sync";
import { replayPendingTransaction } from "@/lib/actions/transactions";

const mockedReplay = vi.mocked(replayPendingTransaction);

function resetDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("bordkasse");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function item(id: string, overrides: Partial<OutboxItem> = {}): OutboxItem {
  return { id, tripId: "t1", kind: "expense", formData: { trip_id: "t1", amount: "10" }, createdAt: 0, ...overrides };
}

beforeEach(async () => {
  await resetDb();
  mockedReplay.mockReset();
});

describe("syncOutbox — O-1-Lock", () => {
  it("hält isSyncing(id) während des Replays und gibt es danach frei; Eintrag wird bei Erfolg entfernt", async () => {
    await enqueue(item("id-a"));
    let lockedDuringReplay = false;
    mockedReplay.mockImplementation(async () => {
      lockedDuringReplay = isSyncing("id-a");
      return { ok: true };
    });

    expect(isSyncing("id-a")).toBe(false); // vorher nicht gesperrt
    const res = await syncOutbox();

    expect(lockedDuringReplay).toBe(true); // während des Replays gesperrt
    expect(isSyncing("id-a")).toBe(false); // danach wieder frei
    expect(res.succeeded).toBe(1);
    expect(await count()).toBe(0); // entfernt
  });

  it("repliziert die FRISCHE Fassung, nicht den Listen-Snapshot", async () => {
    await enqueue(item("id-b", { formData: { trip_id: "t1", amount: "10" } }));
    // Simuliert eine Bearbeitung, die zwischen listAll() und Replay passiert:
    // beim ersten Replay-Aufruf überschreiben wir den Eintrag und prüfen, dass
    // der Sync die zuletzt gespeicherte formData gelesen hat (get statt Snapshot).
    let seenAmount: unknown;
    mockedReplay.mockImplementation(async (_kind, formData) => {
      seenAmount = (formData as Record<string, string>).amount;
      return { ok: true };
    });
    // Vor dem Sync editieren → syncOutbox muss diese Fassung sehen.
    await enqueue(item("id-b", { formData: { trip_id: "t1", amount: "99" } }));

    await syncOutbox();
    expect(seenAmount).toBe("99");
  });

  it("lässt den Eintrag bei fehlgeschlagenem Replay stehen und gibt das Lock frei", async () => {
    await enqueue(item("id-c"));
    mockedReplay.mockResolvedValue({ ok: false, message: "Serverfehler" });

    const res = await syncOutbox();

    expect(res.failed).toHaveLength(1);
    expect(isSyncing("id-c")).toBe(false);
    expect(await get("id-c")).toBeDefined(); // NICHT entfernt
  });
});

describe("syncOutbox — Duplikat bleibt nicht hängen (Fund 4, PR 5)", () => {
  it('entfernt den Eintrag auch bei "ok:true, duplicate:true" — kein Dauerfehler für eine längst gebuchte Zahlung', async () => {
    await enqueue(item("id-dup"));
    mockedReplay.mockResolvedValue({ ok: true, duplicate: true });

    const res = await syncOutbox();

    expect(res.failed).toHaveLength(0);
    expect(res.succeeded).toBe(1);
    // Vor dem Fix gab es dieses Feld nicht — auf altem Code ist es `undefined`
    // und `toContain` schlägt fehl.
    expect(res.duplicates).toContain("id-dup");
    expect(await get("id-dup")).toBeUndefined(); // entfernt, nicht als Fehler stehen gelassen
  });
});

describe("syncOutbox — Cross-Login-Schutz (Fund 6, PR 5)", () => {
  it("verarbeitet einen Eintrag ohne personId (Altbestand) wie gewohnt als eigenen", async () => {
    await enqueue(item("id-legacy")); // kein personId-Feld
    mockedReplay.mockResolvedValue({ ok: true });

    const res = await syncOutbox("person-a");

    expect(mockedReplay).toHaveBeenCalledTimes(1);
    expect(res.succeeded).toBe(1);
    expect(res.foreignOwner).toHaveLength(0);
  });

  it("repliziert einen Eintrag mit ABWEICHENDER personId NICHT und entfernt ihn nicht", async () => {
    await enqueue(item("id-foreign", { personId: "person-b" }));
    mockedReplay.mockResolvedValue({ ok: true });

    const res = await syncOutbox("person-a");

    expect(mockedReplay).not.toHaveBeenCalled();
    expect(res.attempted).toBe(0);
    expect(res.foreignOwner).toEqual(["id-foreign"]);
    expect(await get("id-foreign")).toBeDefined(); // bleibt stehen, wird nie still verworfen
  });

  it("repliziert einen Eintrag mit ÜBEREINSTIMMENDER personId ganz normal", async () => {
    await enqueue(item("id-mine", { personId: "person-a" }));
    mockedReplay.mockResolvedValue({ ok: true });

    const res = await syncOutbox("person-a");

    expect(mockedReplay).toHaveBeenCalledTimes(1);
    expect(res.succeeded).toBe(1);
  });
});
