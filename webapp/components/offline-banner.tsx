"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { count, subscribeToChanges } from "@/lib/offline/outbox";
import { syncOutbox } from "@/lib/offline/sync";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Sticky Banner: zeigt entweder "Du bist offline" oder
 * "N Buchung(en) warten auf Sync". Triggert beim Online-Werden
 * automatisch den Outbox-Sync.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshPending = useCallback(async () => {
    try {
      setPending(await count());
    } catch {
      setPending(0);
    }
  }, []);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncOutbox();
    } finally {
      setSyncing(false);
      refreshPending();
    }
  }, [refreshPending]);

  // Pending-Counter pflegen + Sync triggern, wenn Online-Status auf true
  // wechselt oder neue Items in die Outbox kommen.
  useEffect(() => {
    const unsubscribe = subscribeToChanges(refreshPending);
    const handle = setTimeout(() => {
      refreshPending();
    }, 0);
    return () => {
      unsubscribe();
      clearTimeout(handle);
    };
  }, [refreshPending]);

  useEffect(() => {
    if (!online) return;
    // setTimeout entkoppelt das setState aus triggerSync vom Effect-Body —
    // der Sync läuft im nächsten Microtask, nicht synchron beim Render.
    const handle = setTimeout(() => {
      triggerSync();
    }, 0);
    return () => clearTimeout(handle);
  }, [online, triggerSync]);

  if (online && pending === 0) return null;

  return (
    <div
      className={
        online
          ? "sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-2 text-xs text-ink"
          : "sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-ink"
      }
      role="status"
    >
      <span className="flex items-center gap-2">
        <CloudOff className="h-4 w-4" />
        {online
          ? `${pending} ${pending === 1 ? "Buchung wartet" : "Buchungen warten"} auf Sync`
          : "Offline — Buchungen werden lokal gespeichert"}
      </span>
      {online && pending > 0 && (
        <button
          type="button"
          onClick={triggerSync}
          disabled={syncing}
          className="flex items-center gap-1 rounded border border-primary px-2 py-1 text-primary hover:bg-primary hover:text-paper disabled:opacity-60"
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Synchronisiere …" : "Jetzt synchronisieren"}
        </button>
      )}
    </div>
  );
}
