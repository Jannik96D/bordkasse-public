"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Geteilte Basis für die beiden Settlement-Mail-Buttons (Abrechnung verschicken
 * / Update-Mail verschicken). Beide waren zuvor fast identische Komponenten;
 * hier einmal die gemeinsame Mechanik (Confirm → Action → Status/Fehler-Zeile),
 * die dünnen Wrapper reichen nur Action, Labels und Icon durch (Fund V-3).
 *
 * a11y: Ergebnis-Zeile `role="status"`, Fehler-Zeile `role="alert"` (K-2/K-3).
 */
type MailResult =
  | { ok: true; sent: number; skipped: number; failed: number }
  | { ok: false; message: string };

export function SettlementMailButton({
  tripId,
  action,
  confirmTitle,
  confirmBody,
  confirmLabel = "Verschicken",
  idleLabel,
  pendingLabel = "Versende …",
  okPrefix,
  renderIcon,
}: {
  tripId: string;
  action: (tripId: string) => Promise<MailResult>;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel?: string;
  idleLabel: string;
  pendingLabel?: string;
  /** Präfix der Erfolgs-Zeile, z. B. "Abrechnung verschickt". */
  okPrefix: string;
  renderIcon: (pending: boolean) => ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "ok"; sent: number; skipped: number; failed: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const trigger = async () => {
    const ok = await confirm({ title: confirmTitle, body: confirmBody, confirmLabel });
    if (!ok) return;
    startTransition(async () => {
      const res = await action(tripId);
      if (res.ok) setStatus({ kind: "ok", sent: res.sent, skipped: res.skipped, failed: res.failed });
      else setStatus({ kind: "error", message: res.message });
    });
  };

  if (status.kind === "ok") {
    return (
      <p className={`mt-2 text-xs ${status.failed > 0 ? "text-danger" : "text-success"}`} role="status">
        {status.failed > 0 ? "⚠" : "✓"} {okPrefix} — {status.sent} Mail{status.sent === 1 ? "" : "s"} raus
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
        {renderIcon(pending)}
        {pending ? pendingLabel : idleLabel}
      </button>
      {status.kind === "error" && (
        <p className="mt-1 text-xs text-danger" role="alert">{status.message}</p>
      )}
      {confirmDialog}
    </div>
  );
}
