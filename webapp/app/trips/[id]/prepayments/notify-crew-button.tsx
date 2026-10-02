"use client";

/**
 * Knopf „Crew informieren" (PR6) für den Anzahlungsplan und für einzelne
 * Reise-Posten: schickt nach einer Änderung eine Update-Mail mit den
 * aktuellen Beträgen/Fristen an alle Betroffenen. Nur für Skipper/Admin
 * gerendert (die Action prüft die Rolle erneut).
 *
 * Weicher Spam-Schutz: „zuletzt informiert am …" steht sichtbar am Knopf und
 * im Bestätigungsdialog, ein Doppelklick ist durch den Pending-Zustand
 * gesperrt — aber kein harter Block, der Skipper entscheidet.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RefreshCw } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast-provider";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { notifyItemCrew, notifyPlanCrew, type NotifyCrewResult } from "@/lib/actions/prepayment-notify";
import { notifyResultMessage } from "@/lib/prepayments/notify";
import { NETWORK_ERROR_MESSAGE } from "@/lib/prepayments/item-ui";

export function NotifyCrewButton({
  tripId,
  itemId,
  subject,
  lastNotifiedLabel,
}: {
  tripId: string;
  /** Gesetzt → Posten, sonst Anzahlungsplan. */
  itemId?: string;
  /** Wofür (im Dialog-Titel), z. B. „den Anzahlungsplan" oder „Flüge". */
  subject: string;
  /** Server-seitig formatiert (formatNotifiedAt) — kein Intl im Client-Render, kein Hydration-Mismatch. */
  lastNotifiedLabel: string | null;
}) {
  const vocab = useTripVocab();
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const last = lastNotifiedLabel;
  const descId = `notify-${itemId ?? "plan"}-last`;

  async function run() {
    setError(null);
    const ok = await confirm({
      title: `${vocab.crew} über ${subject} informieren?`,
      body:
        `Alle Personen mit Anteil bekommen eine Mail mit den aktuellen Beträgen und Fristen.` +
        (last ? ` Zuletzt informiert am ${last}.` : ""),
      confirmLabel: "Mail verschicken",
    });
    if (!ok) return;
    startTransition(async () => {
      let res: NotifyCrewResult;
      try {
        res = itemId ? await notifyItemCrew(tripId, itemId) : await notifyPlanCrew(tripId);
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      const msg = notifyResultMessage(res);
      toast.show(msg.message, { variant: msg.variant });
      router.refresh();
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (!pending) void run();
        }}
        aria-disabled={pending}
        aria-describedby={last ? descId : undefined}
        className={`inline-flex min-h-[44px] items-center gap-1 rounded-md border border-rule px-3 py-2 text-sm hover:border-primary/40 hover:bg-navy-light/20 focus:outline-none focus:ring-2 focus:ring-primary/20 ${
          pending ? "cursor-not-allowed opacity-60" : ""
        }`}
      >
        {pending ? (
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Mail className="h-4 w-4" aria-hidden="true" />
        )}
        {vocab.crew} informieren
      </button>
      {last && (
        // Kein role="status": statischer Text, sonst doppelte Ansage neben dem Toast.
        <p id={descId} className="mt-1 text-xs text-ink-soft">
          Zuletzt informiert am {last}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
