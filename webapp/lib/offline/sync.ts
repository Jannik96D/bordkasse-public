"use client";

import { listAll, get, remove, type OutboxItem } from "./outbox";
import { replayPendingTransaction } from "@/lib/actions/transactions";

let inFlight: Promise<SyncResult> | null = null;

// IDs, die gerade repliziert werden. Der Draft-Editor prüft das vor dem
// Überschreiben (Fund O-1): würde er einen Eintrag speichern, während der Sync
// ihn mit dem gleichen idempotency_key schon zum Server geschickt hat, ginge
// die Bearbeitung verloren (Server-Insert gewinnt, remove() löscht die neue
// Fassung, bzw. der Zweit-Replay läuft in die Unique-Violation). Single-Tab,
// Single-Thread → ein In-Memory-Set genügt als Lock zwischen den await-Punkten.
const syncingIds = new Set<string>();

/** Wird der Outbox-Eintrag gerade synchronisiert? (Fund O-1) */
export function isSyncing(id: string): boolean {
  return syncingIds.has(id);
}

export type SyncResult = {
  attempted: number;
  succeeded: number;
  failed: { id: string; message: string }[];
};

/**
 * Arbeitet die Outbox einmal komplett ab. Mehrfache parallele Aufrufe
 * werden zusammengeführt, damit Online-Event + Manual-Trigger nicht
 * doppelt feuern. Idempotency-Keys auf Server-Seite schützen zusätzlich.
 */
export async function syncOutbox(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result: SyncResult = { attempted: 0, succeeded: 0, failed: [] };
    let items: OutboxItem[];
    try {
      items = await listAll();
    } catch {
      return result;
    }
    for (const snapshot of items) {
      result.attempted += 1;
      syncingIds.add(snapshot.id);
      try {
        // Eintrag FRISCH lesen statt aus dem Listen-Snapshot (Fund O-1): der
        // Nutzer könnte ihn zwischen listAll() und hier bearbeitet haben — dann
        // wird die aktuelle Fassung repliziert, nicht die veraltete.
        const item = await get(snapshot.id);
        if (!item) continue; // zwischenzeitlich verworfen
        const res = await replayPendingTransaction(item.kind, item.formData);
        if (res.ok) {
          await remove(item.id);
          result.succeeded += 1;
        } else {
          result.failed.push({ id: item.id, message: res.message });
        }
      } catch (err) {
        result.failed.push({
          id: snapshot.id,
          message: err instanceof Error ? err.message : "Unbekannter Fehler",
        });
      } finally {
        syncingIds.delete(snapshot.id);
      }
    }
    return result;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
