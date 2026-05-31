"use client";

import { useEffect } from "react";

/**
 * Wärmt das Buchungs-Formular für den Offline-Einsatz vor.
 *
 * Beim Öffnen eines Törns (online) holt diese Komponente einmal das voll
 * gerenderte Dokument von `/trips/<id>/transactions/new`. Der GET läuft durch
 * den Service Worker und trifft dort den `networkFirst`-Zweig (Accept text/html)
 * → das Dokument inkl. aktueller Crew landet im PAGES_CACHE. Geht der Skipper
 * später auf See offline, liefert der SW dieses gecachte Form-Dokument bei einer
 * Hard-Navigation (FAB / Entwurf-Bearbeiten) aus.
 *
 * Idempotent + billig: ein einzelner Fetch pro Mount, Fehler werden geschluckt.
 * Bei jedem erneuten Online-Öffnen wird der Cache aufgefrischt (aktuelle Crew).
 */
export function PrefetchOfflineForm({ tripId }: { tripId: string }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.onLine) return;
    if (!("serviceWorker" in navigator)) return;

    const controller = new AbortController();
    // Kleiner Verzug, damit das Vorwärmen nicht mit dem initialen Seiten-Render
    // um Bandbreite konkurriert.
    const handle = setTimeout(() => {
      fetch(`/trips/${tripId}/transactions/new`, {
        headers: { Accept: "text/html" },
        credentials: "include",
        signal: controller.signal,
      }).catch(() => {
        // Offline/abgebrochen/Fehler → kein Problem, beim nächsten Besuch erneut.
      });
    }, 1200);

    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [tripId]);

  return null;
}
