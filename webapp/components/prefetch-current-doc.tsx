"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Wärmt das HTML-Dokument der AKTUELL besuchten Törn-Seite für den Offline-
 * Reload vor.
 *
 * Problem: Next App Router navigiert clientseitig per RSC — das vollständige
 * HTML-Dokument einer Route wird dabei NIE geladen, landet also nicht im
 * PAGES_CACHE des Service Workers. Lädt der Nutzer offline neu (oder kehrt aus
 * dem Hintergrund zurück), findet der SW kein Dokument und liefert die
 * Sackgassen-Seite /offline.html — aus der man „nicht mehr rauskommt".
 *
 * Lösung: Beim Öffnen einer Törn-Seite (online) einmal das HTML-Dokument der
 * aktuellen URL nachladen (Accept: text/html) → der SW cacht es per
 * networkFirst. Ein Reload offline liefert dann die echte, gecachte Seite, und
 * die App bleibt offline nutzbar. Die JS-Chunks der Seite liegen ohnehin schon
 * im Cache, weil die Seite gerade gerendert wird.
 *
 * Billig + idempotent: höchstens ein Fetch pro Pfad pro Session; Fehler werden
 * geschluckt (und der Pfad zum erneuten Versuch wieder freigegeben). Ergänzt
 * `PrefetchOfflineForm` (das gezielt das Buchungsformular für den FAB wärmt).
 */
export function PrefetchCurrentDoc() {
  const pathname = usePathname();
  const warmed = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.onLine) return;
    if (!("serviceWorker" in navigator)) return;

    // Aktuelle Seite UND die Startseite "/" vorwärmen. "/" ist das Ziel des
    // „Zur Startseite"-Escapes auf der Offline-Seite — ist sie nicht gecacht,
    // landet ein Offline-Reload dort in einer Sackgasse, aus der der Link nicht
    // herausführt (genau das gemeldete Symptom).
    const targets = (pathname === "/" ? ["/"] : [pathname, "/"]).filter(
      (p) => !warmed.current.has(p),
    );
    if (targets.length === 0) return;
    targets.forEach((p) => warmed.current.add(p));

    const controller = new AbortController();
    // Kleiner Verzug, damit das Vorwärmen nicht mit dem Seiten-Render um
    // Bandbreite konkurriert.
    const handle = setTimeout(() => {
      for (const p of targets) {
        fetch(p, {
          headers: { Accept: "text/html" },
          credentials: "include",
          signal: controller.signal,
        }).catch(() => {
          // Offline/abgebrochen/Fehler → Pfad wieder freigeben, beim nächsten
          // Besuch erneut versuchen.
          warmed.current.delete(p);
        });
      }
    }, 1500);

    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [pathname]);

  return null;
}
