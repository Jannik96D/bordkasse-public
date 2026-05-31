"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteTransaction } from "@/lib/actions/transactions";
import { useConfirm } from "@/components/confirm-dialog";

export function DeleteButton({ transactionId, tripId }: { transactionId: string; tripId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();

  const handleClick = async () => {
    const ok = await confirm({
      title: "Buchung löschen?",
      body: "Die Buchung verschwindet aus der Bilanz aller Crewmitglieder. Das lässt sich nicht rückgängig machen.",
      confirmLabel: "Löschen",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteTransaction(transactionId, tripId);
      if (res.ok && res.wasKaution) {
        // Kaution-Buchung gelöscht → Skipper zur Trip-Übersicht schicken,
        // wo der Settlement-Banner ihn an die Abrechnung erinnert.
        router.push(`/trips/${tripId}?check_settlement=1`);
      }
    });
  };

  return (
    <>
      <button
        onClick={handleClick}
        disabled={pending}
        className="text-ink-soft hover:text-danger disabled:opacity-50"
        aria-label="Buchung löschen"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {confirmDialog}
    </>
  );
}
