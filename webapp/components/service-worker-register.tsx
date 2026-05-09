"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Registriert den Service Worker für Offline-Caching der App-Shell und
 * zeigt einen Update-Prompt, wenn eine neue SW-Version verfügbar ist.
 *
 * Im Dev-Modus wird der SW deregistriert, damit Hot-Reload und SSR
 * nicht durch Cache-Reste verfälscht werden.
 */
export function ServiceWorkerRegister() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      return;
    }

    let cancelled = false;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (cancelled) return;

        // Bei initialem Load: gibt es bereits einen wartenden Worker?
        if (registration.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(registration.waiting);
        }

        // Neue Version wird gerade installiert.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaitingWorker(installing);
            }
          });
        });
      })
      .catch((err) => {
        console.error("Service Worker Registration fehlgeschlagen:", err);
      });

    // Wenn der wartende Worker übernommen hat, einmal neu laden, damit
    // die neue Asset-Version zum Zug kommt.
    const onControllerChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waitingWorker) return null;

  return (
    <div className="fixed inset-x-0 bottom-20 z-50 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-md border border-primary bg-paper px-4 py-3 text-sm shadow-lg">
      <span>Neue Version verfügbar.</span>
      <button
        type="button"
        onClick={() => waitingWorker.postMessage({ type: "SKIP_WAITING" })}
        className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-paper hover:bg-navy-dark"
      >
        <RefreshCw className="h-3 w-3" />
        Aktualisieren
      </button>
    </div>
  );
}
