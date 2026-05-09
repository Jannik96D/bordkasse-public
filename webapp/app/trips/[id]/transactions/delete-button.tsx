"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteTransaction } from "@/lib/actions/transactions";

export function DeleteButton({ transactionId, tripId }: { transactionId: string; tripId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      onClick={() =>
        startTransition(() => {
          if (confirm("Buchung löschen?")) {
            deleteTransaction(transactionId, tripId);
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
