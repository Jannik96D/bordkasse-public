"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteTransaction } from "@/lib/actions/transactions";

export function DeleteButton({ transactionId, tripId }: { transactionId: string; tripId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      onClick={() =>
        startTransition(async () => {
          if (!confirm("Buchung löschen?")) return;
          const res = await deleteTransaction(transactionId, tripId);
          if (res.ok && res.wasKaution) {
            // Kaution-Buchung gelöscht → Skipper zur Trip-Übersicht schicken,
            // wo der Settlement-Banner ihn an die Abrechnung erinnert.
            router.push(`/trips/${tripId}?check_settlement=1`);
          }
        })
      }
      disabled={pending}
      className="text-ink-soft hover:text-danger disabled:opacity-50"
      aria-label="Buchung löschen"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
