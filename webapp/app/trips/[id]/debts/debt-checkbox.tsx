"use client";

import { useOptimistic, useTransition } from "react";
import { toggleDebtSettled } from "@/lib/actions/settled-debts";
import { useToast } from "@/components/toast-provider";
import { useTripVocab } from "@/components/trip-vocab-provider";

/**
 * "Erledigt"-Häkchen pro Schuldenzeile. Persistiert trip-übergreifend in
 * der DB (Tabelle settled_debts) — andere Crewmitglieder sehen den Status
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
  const { show } = useToast();
  const vocab = useTripVocab();

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
          const res = await toggleDebtSettled({
            tripId,
            fromPersonId,
            toPersonId,
            amount,
            settled: next,
          });
          if (!res.ok) {
            // useOptimistic fällt nach dem Transition-Ende automatisch auf
            // initialSettled zurück (kein revalidate bei Fehler) — wir müssen
            // den Haken also nicht manuell zurücksetzen, nur melden.
            show(res.message ?? "Speichern fehlgeschlagen.", { variant: "error" });
            return;
          }
          if (next) {
            const failed = res.mailsFailed ?? 0;
            show(
              failed > 0
                ? `Als bezahlt markiert. ${failed} Benachrichtigung${failed === 1 ? "" : "en"} konnte${failed === 1 ? "" : "n"} nicht zugestellt werden.`
                : `Als bezahlt markiert. ${vocab.crew} wurde benachrichtigt.`,
              { variant: failed > 0 ? "error" : "success" },
            );
          }
        });
      }}
      className="h-5 w-5 cursor-pointer rounded border-rule disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={optimisticSettled ? "Als unbezahlt markieren" : "Als erledigt markieren"}
      title={canToggle ? undefined : "Nur wer zahlt oder das Geld bekommt darf das Häkchen setzen."}
    />
  );
}
