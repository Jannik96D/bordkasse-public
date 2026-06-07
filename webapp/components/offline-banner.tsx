"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CloudOff, RefreshCw, AlertTriangle, Smartphone } from "lucide-react";
import { count, remove, subscribeToChanges } from "@/lib/offline/outbox";
import { syncOutbox } from "@/lib/offline/sync";
import { readOfflineMiss, clearOfflineMiss } from "@/lib/offline/offline-help";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Sticky Banner: zeigt "Du bist offline", "N Buchung(en) warten auf Sync"
 * oder — falls ein Replay dauerhaft fehlschlägt — eine Fehlermeldung mit
 * Verwerfen-Aktion. Ohne Letzteres bliebe ein kaputter Outbox-Eintrag ewig
 * hängen und der Banner ginge nie weg ("die App ist kaputt"-Effekt).
 * Triggert beim Online-Werden automatisch den Outbox-Sync.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState<{ id: string; message: string }[]>([]);
  const [showHelp, setShowHelp] = useState(false);

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
      const result = await syncOutbox();
      setFailed(result.failed);
    } finally {
      setSyncing(false);
      refreshPending();
    }
  }, [refreshPending]);

  const discardFailed = useCallback(async () => {
    for (const f of failed) {
      try {
        await remove(f.id);
      } catch {
        // Best-effort — was sich nicht löschen lässt, taucht beim nächsten
        // Sync erneut auf.
      }
    }
    setFailed([]);
    refreshPending();
  }, [failed, refreshPending]);

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

  // Selbsthilfe: fand der letzte Offline-Versuch das Buchungsformular nicht im
  // Cache (Flag von FAB / offline.html), beim Online-Sein eine kurze Hilfe
  // zeigen. Auf Mount UND beim Online-Werden prüfen — der Banner bleibt über
  // Tab-Wechsel montiert, ein reiner Mount-Check verpasste den
  // Offline→Online-Übergang.
  useEffect(() => {
    if (!online) return;
    Promise.resolve().then(() => {
      if (readOfflineMiss()) {
        setShowHelp(true);
        clearOfflineMiss(); // clear-on-show → kein erneutes Aufpoppen nach Reload
      }
    });
  }, [online]);

  const hasFailed = failed.length > 0;
  // Online, nichts ausstehend/fehlgeschlagen: höchstens die Selbsthilfe nach
  // einem gescheiterten Offline-Versuch, sonst gar kein Banner.
  if (online && pending === 0 && !hasFailed) {
    if (!showHelp) return null;
    return (
      <div
        className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-primary/30 bg-navy-light/40 px-4 py-2 text-xs text-ink"
        role="status"
      >
        <span className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          Offline-Buchen ging zuletzt nicht. Das Formular ist jetzt vorbereitet — für
          unterwegs am besten die App installieren.
        </span>
        <button
          type="button"
          onClick={() => setShowHelp(false)}
          className="shrink-0 rounded border border-primary px-2 py-1 text-primary hover:bg-primary hover:text-paper"
        >
          OK
        </button>
      </div>
    );
  }

  // Fehler-Zustand hat Vorrang: dauerhaft fehlgeschlagene Replays.
  if (online && hasFailed) {
    return (
      <div
        className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-ink"
        role="alert"
      >
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-danger" />
          {failed.length === 1
            ? "1 Buchung konnte nicht übertragen werden"
            : `${failed.length} Buchungen konnten nicht übertragen werden`}
          {failed[0]?.message ? `: ${failed[0].message}` : ""}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={triggerSync}
            disabled={syncing}
            className="flex items-center gap-1 rounded border border-primary px-2 py-1 text-primary hover:bg-primary hover:text-paper disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            Erneut
          </button>
          <button
            type="button"
            onClick={discardFailed}
            className="rounded border border-danger px-2 py-1 text-danger hover:bg-danger hover:text-paper"
          >
            Verwerfen
          </button>
        </span>
      </div>
    );
  }

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
          ? `${pending} ${pending === 1 ? "Buchung wartet" : "Buchungen warten"} auf Übertragung`
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
