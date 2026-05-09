"use client";

import { useTransition } from "react";
import { Archive, Trash2 } from "lucide-react";
import { toggleArchive, deleteTrip } from "@/lib/actions/trips";

export function ArchiveBlock({ tripId, archived }: { tripId: string; archived: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <section className="space-y-2 border-t border-rule pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Verwaltung</h2>
      <button
        disabled={pending}
        onClick={() => startTransition(() => toggleArchive(tripId, !archived))}
        className="flex w-full items-center gap-3 rounded-md border border-rule bg-paper px-4 py-3 text-left text-sm hover:bg-paper-soft disabled:opacity-60"
      >
        <Archive className="h-4 w-4 text-ink-soft" />
        {archived ? "Aus Archiv holen" : "Törn archivieren"}
      </button>
      <button
        disabled={pending}
        onClick={() => {
          if (confirm("Törn unwiderruflich löschen? Alle Buchungen, Crew, Kategorien gehen verloren.")) {
            startTransition(() => deleteTrip(tripId));
          }
        }}
        className="flex w-full items-center gap-3 rounded-md border border-danger/30 bg-paper px-4 py-3 text-left text-sm text-danger hover:bg-danger/5 disabled:opacity-60"
      >
        <Trash2 className="h-4 w-4" />
        Törn löschen
      </button>
    </section>
  );
}
