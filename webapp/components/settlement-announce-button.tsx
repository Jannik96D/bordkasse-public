"use client";

import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { announceSettlement } from "@/lib/actions/settlement";
import { useConfirm } from "@/components/confirm-dialog";
import { useTripVocab } from "@/components/trip-vocab-provider";

/**
 * Skipper-Button "Abrechnung verschicken" — löst Mailversand an die Crew aus
 * und schaltet die Bezahlt-Häkchen frei. Mit `confirm()`, damit der Click
 * nicht versehentlich passiert (Idempotent ist die Action zwar, aber die
 * Mails wären weg).
 */
export function SettlementAnnounceButton({ tripId }: { tripId: string }) {
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const vocab = useTripVocab();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "ok"; sent: number; skipped: number; failed: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const trigger = async () => {
    const ok = await confirm({
      title: "Abrechnung verschicken?",
      body: `Es geht eine Mail an jedes ${vocab.member} mit E-Mail-Adresse — mit Saldo und Zahlungsplan. Danach sind die Bezahlt-Häkchen freigeschaltet.`,
      confirmLabel: "Verschicken",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await announceSettlement(tripId);
      if (res.ok) setStatus({ kind: "ok", sent: res.sent, skipped: res.skipped, failed: res.failed });
      else setStatus({ kind: "error", message: res.message });
    });
  };

  if (status.kind === "ok") {
    return (
      <p className={`mt-2 text-xs ${status.failed > 0 ? "text-danger" : "text-success"}`}>
        {status.failed > 0 ? "⚠" : "✓"} Abrechnung verschickt — {status.sent} Mail{status.sent === 1 ? "" : "s"} raus
        {status.failed > 0 && `, ${status.failed} fehlgeschlagen`}
        {status.skipped > 0 && `, ${status.skipped} ohne Email-Adresse übersprungen`}.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={trigger}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        <Send className="h-3.5 w-3.5" aria-hidden />
        {pending ? "Versende …" : "Abrechnung verschicken"}
      </button>
      {status.kind === "error" && (
        <p className="mt-1 text-xs text-danger">{status.message}</p>
      )}
      {confirmDialog}
    </div>
  );
}
