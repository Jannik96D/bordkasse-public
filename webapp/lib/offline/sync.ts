"use client";

import { listAll, remove, type OutboxItem } from "./outbox";
import { replayPendingTransaction } from "@/lib/actions/transactions";

let inFlight: Promise<SyncResult> | null = null;

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
    for (const item of items) {
      result.attempted += 1;
      try {
        const res = await replayPendingTransaction(item.kind, item.formData);
        if (res.ok) {
          await remove(item.id);
          result.succeeded += 1;
        } else {
          result.failed.push({ id: item.id, message: res.message });
        }
      } catch (err) {
        result.failed.push({
          id: item.id,
          message: err instanceof Error ? err.message : "Unbekannter Fehler",
        });
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
