"use client";

import { useOptimistic, useTransition } from "react";
import { toggleDebtSettled } from "@/lib/actions/settled-debts";

/**
 * "Erledigt"-Häkchen pro Schuldenzeile. Persistiert trip-übergreifend in
 * der DB (Tabelle settled_debts) — andere Crew-Mitglieder sehen den Status
 * live via Realtime-Sync (RealtimeTrip).
 *
 * useOptimistic gibt sofort UI-Feedback und resettet sich beim nächsten
 * Server-Render auf den neuen `initialSettled`-Prop, falls der Server-
 * Stand abweicht (z. B. wenn jemand parallel toggelt oder der Toggle
 * fehlschlägt).
 */
export function DebtCheckbox({
  tripId,
  fromPersonId,
  toPersonId,
  amount,
  initialSettled,
  canToggle,
}: {
  tripId: string;
  fromPersonId: string;
  toPersonId: string;
  amount: number;
  initialSettled: boolean;
  canToggle: boolean;
}) {
  const [optimisticSettled, setOptimisticSettled] = useOptimistic(initialSettled);
  const [pending, startTransition] = useTransition();

  return (
    <input
      type="checkbox"
      checked={optimisticSettled}
      disabled={pending || !canToggle}
      onChange={(e) => {
        if (!canToggle) return;
        const next = e.target.checked;
        startTransition(async () => {
          setOptimisticSettled(next);
          await toggleDebtSettled({
            tripId,
            fromPersonId,
            toPersonId,
            amount,
            settled: next,
          });
        });
      }}
      className="h-5 w-5 cursor-pointer rounded border-rule disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={optimisticSettled ? "Als unbezahlt markieren" : "Als erledigt markieren"}
      title={canToggle ? undefined : "Nur wer zahlt oder das Geld bekommt darf das Häkchen setzen."}
    />
  );
}
