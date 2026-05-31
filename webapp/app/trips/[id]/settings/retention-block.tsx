"use client";

import { useState, useTransition } from "react";
import { Eraser } from "lucide-react";
import { purgeTripNow } from "@/lib/actions/trips";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Manueller DSGVO-Purge-Button für Skipper/Admin. Versucht zuerst ohne
 * Force (= normale Cron-Bedingungen), zeigt bei Refusal die Begründung und
 * — wenn der Grund die Retention-Frist oder fehlende Settlement-Mail ist —
 * einen zweiten Button für den Force-Modus. Schulden-Refusal bleibt immer
 * blockierend (sonst Datenverlust für offene Zahlungen).
 *
 * Wird nur eingebunden, wenn der Trip noch nicht gepurged ist.
 */
export function RetentionBlock({ tripId }: { tripId: string }) {
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "soft_blocked"; message: string }
    | { kind: "hard_blocked"; message: string }
    | { kind: "ok"; message: string }
  >({ kind: "idle" });

  const trigger = async (force: boolean) => {
    const ok = await confirm(
      force
        ? {
            title: "Daten sofort löschen?",
            body: "Buchungen, Crew und Schulden dieses Törns werden anonymisiert, nur die aggregierte Statistik bleibt. Das lässt sich nicht rückgängig machen.",
            confirmLabel: "Trotzdem löschen",
            danger: true,
          }
        : {
            title: "Personenbezogene Daten löschen?",
            body: "Voraussetzung: alle Schulden bezahlt und 30 Tage seit Törnende. Aggregierte Statistik bleibt anonymisiert erhalten.",
            confirmLabel: "Löschen",
            danger: true,
          },
    );
    if (!ok) return;

    startTransition(async () => {
      const res = await purgeTripNow(tripId, force);
      if (res.ok) {
        setState({ kind: "ok", message: res.message });
      } else if (res.message.includes("Schulden")) {
        // "debts_open" → kein Force möglich
        setState({ kind: "hard_blocked", message: res.message });
      } else {
        setState({ kind: "soft_blocked", message: res.message });
      }
    });
  };

  if (state.kind === "ok") {
    return (
      <section className="space-y-2 border-t border-rule pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">DSGVO-Löschung</h2>
        <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          ✓ {state.message}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2 border-t border-rule pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">DSGVO-Löschung</h2>
      <p className="text-xs text-ink-soft">
        Personenbezogene Daten (Buchungen, Crew, Schulden) werden 30 Tage nach Törnende automatisch gelöscht, vorausgesetzt
        die Abrechnung wurde verschickt und alle Zahlungen sind erledigt. Aggregierte Statistik (Kategorie + Tag) bleibt
        anonymisiert erhalten. Falls die Automatik mal nicht greift, kannst du den Vorgang hier manuell anstoßen.
      </p>
      <button
        disabled={pending}
        onClick={() => trigger(false)}
        className="flex w-full items-center gap-3 rounded-md border border-rule bg-paper px-4 py-3 text-left text-sm hover:bg-paper-soft disabled:opacity-60"
      >
        <Eraser className="h-4 w-4 text-ink-soft" />
        {pending ? "Löschen läuft …" : "Personenbezogene Daten jetzt löschen"}
      </button>

      {state.kind === "soft_blocked" && (
        <div className="space-y-2 rounded-md border border-gold/30 bg-gold-soft p-3 text-sm">
          <p className="text-ink">{state.message}</p>
          <button
            disabled={pending}
            onClick={() => trigger(true)}
            className="w-full rounded-md border border-danger/40 bg-paper px-3 py-2 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-60"
          >
            Trotzdem jetzt löschen
          </button>
        </div>
      )}

      {state.kind === "hard_blocked" && (
        <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      {confirmDialog}
    </section>
  );
}
