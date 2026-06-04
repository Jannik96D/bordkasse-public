"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { resendSettlement } from "@/lib/actions/settlement";
import { useConfirm } from "@/components/confirm-dialog";
import { useTripVocab } from "@/components/trip-vocab-provider";

/**
 * Skipper-Button "Update-Mail verschicken" — wird angezeigt, wenn nach der
 * initialen Abrechnung Buchungen geändert wurden (changes_pending_since
 * gesetzt). Schickt eine Mail mit dem Wortlaut "Bilanz aktualisiert" und
 * dem aktuellen Saldo + Zahlungsplan an jedes Crewmitglied.
 */
export function SettlementResendButton({ tripId }: { tripId: string }) {
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
      title: "Update-Mail verschicken?",
      body: `Alle in der ${vocab.crew} mit E-Mail-Adresse bekommen eine Mail mit der aktualisierten Bilanz und dem neuen Zahlungsplan.`,
      confirmLabel: "Verschicken",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await resendSettlement(tripId);
      if (res.ok) setStatus({ kind: "ok", sent: res.sent, skipped: res.skipped, failed: res.failed });
      else setStatus({ kind: "error", message: res.message });
    });
  };

  if (status.kind === "ok") {
    return (
      <p className={`mt-2 text-xs ${status.failed > 0 ? "text-danger" : "text-success"}`}>
        {status.failed > 0 ? "⚠" : "✓"} Update verschickt — {status.sent} Mail{status.sent === 1 ? "" : "s"} raus
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
        <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden />
        {pending ? "Versende …" : "Update-Mail verschicken"}
      </button>
      {status.kind === "error" && (
        <p className="mt-1 text-xs text-danger">{status.message}</p>
      )}
      {confirmDialog}
    </div>
  );
}
