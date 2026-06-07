"use client";

import { useEffect } from "react";

/**
 * Wärmt das Buchungs-Formular für den Offline-Einsatz vor.
 *
 * Beim Öffnen eines Törns (online) holt diese Komponente das voll gerenderte
 * Dokument von `/trips/<id>/transactions/new`. Der GET läuft durch den Service
 * Worker und trifft dort den `networkFirst`-Zweig (Accept text/html) → das
 * Dokument inkl. aktueller Crew landet im PAGES_CACHE. Geht der Skipper später
 * auf See offline, liefert der SW dieses gecachte Form-Dokument bei einer
 * Hard-Navigation (FAB / Entwurf-Bearbeiten) aus.
 *
 * Robustheit (Fix iOS-Offline): KEIN `setTimeout`-Verzug mehr — verließ der
 * Nutzer den Törn in den alten 1,2 s, blieb das Formular ungewärmt und der
 * FAB lief offline in die Sackgasse (/offline.html). Zusätzlich wird bei
 * `online` (Empfang kommt zurück) und `visibilitychange` (Tab wieder im
 * Vordergrund) erneut gewärmt, damit der Cache frisch ist — gerade kurz bevor
 * der Empfang womöglich wieder wegfällt.
 *
 * Idempotent + billig: parallele Warm-Fetches sind unschädlich (idempotenter
 * GET; der SW cacht den letzten), alle Fehler werden geschluckt.
 */
export function PrefetchOfflineForm({ tripId }: { tripId: string }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const url = `/trips/${tripId}/transactions/new`;
    const inflight = new Set<AbortController>();

    const warm = () => {
      if (!navigator.onLine) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const ac = new AbortController();
      inflight.add(ac);
      fetch(url, {
        headers: { Accept: "text/html" },
        credentials: "include",
        signal: ac.signal,
      })
        .catch(() => {
          // Offline/abgebrochen/Fehler → kein Problem, beim nächsten Auslöser erneut.
        })
        .finally(() => inflight.delete(ac));
    };

    // Sofort beim Öffnen wärmen.
    warm();

    const onOnline = () => warm();
    const onVisible = () => {
      if (document.visibilityState === "visible") warm();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      inflight.forEach((ac) => ac.abort());
    };
  }, [tripId]);

  return null;
}
