"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportMyData } from "./actions";

/**
 * DSGVO Art. 20: lädt die eigenen Daten als JSON herunter. Der Server liefert
 * den JSON-String, der Browser erzeugt daraus einen Blob-Download.
 */
export function DataExportBlock() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    startTransition(async () => {
      const res = await exportMyData();
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      const blob = new Blob([res.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  return (
    <div className="mt-8 border-t border-rule pt-6">
      <h2 className="text-sm font-semibold text-primary">Meine Daten exportieren</h2>
      <p className="mt-1 text-xs text-ink-soft">
        Lade alle in der Bordkasse zu dir gespeicherten Daten als JSON-Datei herunter
        (Datenübertragbarkeit nach Art. 20 DSGVO).
      </p>
      <button
        type="button"
        onClick={handleExport}
        disabled={pending}
        className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary hover:text-paper disabled:opacity-60"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {pending ? "Wird erstellt …" : "Datenexport herunterladen"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
