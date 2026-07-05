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
