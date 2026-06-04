"use client";

import { useTransition } from "react";
import { Archive, Trash2 } from "lucide-react";
import { toggleArchive, deleteTrip } from "@/lib/actions/trips";
import { useConfirm } from "@/components/confirm-dialog";
import { useTripVocab } from "@/components/trip-vocab-provider";

export function ArchiveBlock({ tripId, archived }: { tripId: string; archived: boolean }) {
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const vocab = useTripVocab();

  const handleDelete = async () => {
    const ok = await confirm({
      title: `${vocab.trip} unwiderruflich löschen?`,
      body: `Alle Buchungen, die ${vocab.crew} und die Kategorien ${vocab.trip === "Reise" ? "dieser Reise" : "dieses Törns"} gehen verloren. Das lässt sich nicht rückgängig machen.`,
      confirmLabel: "Endgültig löschen",
      danger: true,
    });
    if (!ok) return;
    startTransition(() => deleteTrip(tripId));
  };

  return (
    <section className="space-y-2 border-t border-rule pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Verwaltung</h2>
      <button
        disabled={pending}
        onClick={() => startTransition(() => toggleArchive(tripId, !archived))}
        className="flex w-full items-center gap-3 rounded-md border border-rule bg-paper px-4 py-3 text-left text-sm hover:bg-paper-soft disabled:opacity-60"
      >
        <Archive className="h-4 w-4 text-ink-soft" />
        {archived ? "Aus Archiv holen" : `${vocab.trip} archivieren`}
      </button>
      <button
        disabled={pending}
        onClick={handleDelete}
        className="flex w-full items-center gap-3 rounded-md border border-danger/30 bg-paper px-4 py-3 text-left text-sm text-danger hover:bg-danger/5 disabled:opacity-60"
      >
        <Trash2 className="h-4 w-4" />
        {`${vocab.trip} löschen`}
      </button>
      {confirmDialog}
    </section>
  );
}
