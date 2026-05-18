"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { resendSettlement } from "@/lib/actions/settlement";

/**
 * Skipper-Button "Update-Mail verschicken" — wird angezeigt, wenn nach der
 * initialen Abrechnung Buchungen geändert wurden (changes_pending_since
 * gesetzt). Schickt eine Mail mit dem Wortlaut "Bilanz aktualisiert" und
 * dem aktuellen Saldo + Zahlungsplan an jedes Crew-Mitglied.
 */
export function SettlementResendButton({ tripId }: { tripId: string }) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "ok"; sent: number; skipped: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const trigger = () => {
    if (
      !confirm(
        "Update-Mail an die Crew verschicken? Alle bekommen eine Mail mit der aktualisierten Bilanz.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await resendSettlement(tripId);
      if (res.ok) setStatus({ kind: "ok", sent: res.sent, skipped: res.skipped });
      else setStatus({ kind: "error", message: res.message });
    });
  };

  if (status.kind === "ok") {
    return (
      <p className="mt-2 text-xs text-success">
        ✓ Update verschickt — {status.sent} Mail{status.sent === 1 ? "" : "s"} raus
        {status.skipped > 0 && `, ${status.skipped} übersprungen`}.
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
    </div>
  );
}
