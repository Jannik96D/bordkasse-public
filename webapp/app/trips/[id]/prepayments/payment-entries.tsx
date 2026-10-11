"use client";

/**
 * Bausteine des Erfassen-Dialogs, geteilt von Anzahlungsplan und weiteren
 * Zahlungen (Bugfix Doppelzahlung):
 *   • PendingResolveField — zeigt offene Selbstmeldungen der Person und den
 *     Haken „Gemeldete Zahlung damit erledigt" (Standard an). Ohne ihn blieb
 *     die Meldung nach dem Erfassen stehen, und ein späteres „Bestätigen"
 *     buchte dasselbe Geld doppelt.
 *   • PaymentEntryList — bisherige Einzahlungen der Person mit „Entfernen",
 *     damit eine versehentliche Doppel-/Überzahlung direkt hier
 *     zurückgenommen werden kann (vorher nur über die Buchungsliste).
 *
 * Entfernen fragt inline nach (kein zweites Modal über dem Dialog — gleiches
 * Muster wie „Löschen" im Bearbeiten-Dialog der weiteren Zahlungen).
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Trash2 } from "lucide-react";
import { useToast } from "@/components/toast-provider";
import { formatEuro, round2 } from "@/lib/utils";
import { formatDeDate } from "@/lib/prepayments/dates";

export interface PendingReport {
  transaction_id: string;
  amount: number;
  date: string;
}

export interface PaymentEntryLine {
  transaction_id: string;
  amount: number;
  date: string;
  description: string | null;
}

export function pendingSum(reports: PendingReport[]): number {
  return round2(reports.reduce((s, r) => s + r.amount, 0));
}

export function PendingResolveField({
  personName,
  reports,
  checked,
  onChange,
  idPrefix,
}: {
  personName: string;
  reports: PendingReport[];
  checked: boolean;
  onChange: (v: boolean) => void;
  idPrefix: string;
}) {
  if (reports.length === 0) return null;
  const sum = pendingSum(reports);
  const when = reports.map((r) => formatDeDate(r.date)).join(", ");
  return (
    <div className="mt-4 rounded-md border border-gold/60 bg-gold-soft p-3 text-sm" role="note">
      <p>
        <span aria-hidden="true">⏳ </span>
        {personName} hat {formatEuro(sum)} als gezahlt gemeldet ({when}) — wartet auf Bestätigung.
      </p>
      <label htmlFor={`${idPrefix}-resolve`} className="mt-2 flex min-h-[44px] cursor-pointer items-start gap-2">
        <input
          id={`${idPrefix}-resolve`}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 accent-primary"
        />
        <span>
          <span className="font-medium">Gemeldete Zahlung damit erledigt</span>
          <span className="block text-xs text-ink-soft">
            Die Meldung verschwindet, es zählt nur der Betrag, den du hier erfasst. Haken nur entfernen, wenn es eine
            andere, zusätzliche Zahlung ist.
          </span>
        </span>
      </label>
    </div>
  );
}

export function PaymentEntryList({
  entries,
  canRemove,
  remove,
}: {
  entries: PaymentEntryLine[];
  canRemove: boolean;
  /** Server-Action-Aufruf; liefert eine Fehlermeldung oder null. */
  remove: (transactionId: string) => Promise<string | null>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  // Fokus nicht ins Leere fallen lassen, wenn der fokussierte Knopf verschwindet (a11y).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const trashRefs = useRef(new Map<string, HTMLButtonElement>());

  if (entries.length === 0) return null;

  function doRemove(id: string) {
    setError(null);
    startTransition(async () => {
      let msg: string | null;
      try {
        msg = await remove(id);
      } catch {
        msg = "Keine Verbindung. Bitte erneut versuchen.";
      }
      if (msg) {
        setError(msg);
        return;
      }
      setConfirmId(null);
      headingRef.current?.focus();
      toast.show("Einzahlung entfernt.", { variant: "success" });
      router.refresh();
    });
  }

  return (
    <section className="mt-4" aria-label="Bisherige Einzahlungen">
      <h3 ref={headingRef} tabIndex={-1} className="text-xs font-medium uppercase tracking-wide text-ink-soft focus:outline-none">
        Bisherige Einzahlungen
      </h3>
      <ul className="mt-1 divide-y divide-rule rounded-md border border-rule text-sm">
        {entries.map((e) => {
          const label = `${formatEuro(e.amount)} am ${formatDeDate(e.date)}`;
          return (
            <li key={e.transaction_id} className="px-3 py-1.5">
              <div className="flex min-h-[44px] items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium tabular-nums">{formatEuro(e.amount)}</span>
                  <span className="text-ink-soft"> · {formatDeDate(e.date)}</span>
                  {e.description && <span className="block truncate text-xs text-ink-soft">{e.description}</span>}
                </span>
                {canRemove && confirmId !== e.transaction_id && (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) trashRefs.current.set(e.transaction_id, el);
                      else trashRefs.current.delete(e.transaction_id);
                    }}
                    onClick={() => {
                      setError(null);
                      setConfirmId(e.transaction_id);
                    }}
                    aria-label={`Einzahlung entfernen: ${label}`}
                    title="Entfernen"
                    className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-paper-soft hover:text-danger focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              {confirmId === e.transaction_id && (
                <div role="group" aria-label={`Entfernen bestätigen: ${label}`} className="mb-1 rounded-md bg-danger/5 p-2">
                  <p className="text-xs">Einzahlung über {label} wirklich entfernen? Sie zählt dann nicht mehr als bezahlt.</p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      autoFocus
                      onClick={() => {
                        const id = e.transaction_id;
                        setConfirmId(null);
                        requestAnimationFrame(() => trashRefs.current.get(id)?.focus());
                      }}
                      className="min-h-[44px] rounded-md border border-rule px-3 py-1.5 text-sm hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      onClick={() => doRemove(e.transaction_id)}
                      disabled={busy}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-paper hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-danger/40 disabled:opacity-50"
                    >
                      {busy && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
                      Entfernen
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
