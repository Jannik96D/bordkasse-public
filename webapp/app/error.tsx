"use client";

import { useEffect, useState } from "react";

/**
 * Segment-Error-Boundary. Fängt Render-/Query-Fehler in den App-Routen
 * (z. B. ein transienter DB-Fehler beim Laden eines Törns) und zeigt der
 * Crew eine verständliche deutsche Seite statt der nackten Next.js-500.
 *
 * Offline-bewusst: Die häufigste Ursache an Bord ist fehlender Empfang — eine
 * Client-RSC-Navigation oder Server-Action ohne Netz wirft hier herein. Dann
 * zeigen wir eine ruhige "Du bist offline"-Variante statt "Etwas ist
 * schiefgelaufen", inkl. Hinweis, dass Erfassen über den + weiterhin geht.
 * Der "Zur Törn-Übersicht"-Link ist bewusst eine HARTE Navigation (<a>, kein
 * <Link>): nach einem Fehler kann der Client-Router in einem kaputten Zustand
 * sein, und offline liefert erst die Hard-Navigation die gecachte Seite bzw.
 * die Offline-Seite aus dem Service Worker.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Fürs Serverlog / Monitoring — der User sieht den Stacktrace nie.
    console.error("[bordkasse:error-boundary]", error);
  }, [error]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-primary">
            {offline ? "Du bist offline" : "Etwas ist schiefgelaufen"}
          </h1>
          <p className="text-sm text-ink-soft">
            {offline
              ? "Diese Ansicht braucht Empfang. Buchungen erfassen geht trotzdem über das +-Symbol; sobald du wieder online bist, funktioniert der Rest wieder."
              : "Die Aktion konnte gerade nicht abgeschlossen werden. Oft hilft es, es bei besserem Empfang erneut zu versuchen. Deine bereits gespeicherten Buchungen sind nicht betroffen."}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            Erneut versuchen
          </button>
          <a
            href="/"
            className="w-full rounded-md border border-rule px-4 py-3 text-sm font-medium text-primary hover:bg-paper-soft focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            Zur Törn-Übersicht
          </a>
        </div>
        {error.digest && (
          <p className="text-xs text-ink-soft">Fehler-Kennung: {error.digest}</p>
        )}
      </div>
    </main>
  );
}
