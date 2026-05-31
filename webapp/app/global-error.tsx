"use client";

import { useEffect } from "react";

/**
 * Root-Error-Boundary. Greift nur, wenn der Fehler im Root-Layout selbst
 * auftritt (dann ersetzt diese Komponente das komplette Dokument und muss
 * daher eigene <html>/<body>-Tags mitbringen). Für normale Routen-Fehler
 * greift app/error.tsx.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[bordkasse:global-error]", error);
  }, [error]);

  return (
    <html lang="de">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Arial, sans-serif",
          background: "#FAFBFC",
          color: "#1A1F2A",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: "24rem", textAlign: "center" }}>
          <h1 style={{ color: "#114884", fontSize: "1.5rem", marginBottom: "0.5rem" }}>
            Etwas ist schiefgelaufen
          </h1>
          <p style={{ color: "#4A5468", fontSize: "0.875rem", lineHeight: 1.6 }}>
            Die Bordkasse konnte gerade nicht geladen werden. Bitte versuche es
            erneut.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              borderRadius: "0.375rem",
              background: "#114884",
              color: "#FAFBFC",
              border: "none",
              padding: "0.75rem 1rem",
              fontSize: "1rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Erneut versuchen
          </button>
        </div>
      </body>
    </html>
  );
}
