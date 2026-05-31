"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Segment-Error-Boundary. Fängt Render-/Query-Fehler in den App-Routen
 * (z. B. ein transienter DB-Fehler beim Laden eines Törns) und zeigt der
 * Crew eine verständliche deutsche Seite statt der nackten Next.js-500.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Fürs Serverlog / Monitoring — der User sieht den Stacktrace nie.
    console.error("[bordkasse:error-boundary]", error);
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-primary">Etwas ist schiefgelaufen</h1>
          <p className="text-sm text-ink-soft">
            Die Aktion konnte gerade nicht abgeschlossen werden. Oft hilft es,
            es bei besserem Empfang erneut zu versuchen. Deine bereits
            gespeicherten Buchungen sind nicht betroffen.
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
          <Link
            href="/"
            className="w-full rounded-md border border-rule px-4 py-3 text-sm font-medium text-primary hover:bg-paper-soft focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            Zur Törn-Übersicht
          </Link>
        </div>
        {error.digest && (
          <p className="text-xs text-ink-soft">Fehler-Kennung: {error.digest}</p>
        )}
      </div>
    </main>
  );
}
