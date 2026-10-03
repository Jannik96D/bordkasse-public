"use client";

/**
 * Modale der weiteren Zahlungen (intern `item`, PR4b; Wording PR7):
 *   • ItemPaymentModal         — Einzahlung einer Person an die vorstreckende Person
 *     (mode "record": vorstreckende Person/Skipper/Admin trägt ein, sofort bestätigt;
 *      mode "self": Crew meldet „Ich habe gezahlt", wartet auf Bestätigung)
 *   • ItemProviderPaymentModal — die vorstreckende Person überweist an den Anbieter
 *     („Überweisung an Anbieter erfassen"; Airline/Bahn o. Ä.)
 *
 * Jede Öffnung mountet das Modal neu → der `idempotency_key` wird pro Mount
 * einmal erzeugt (Muster `useBookingSubmit`): ein Doppelklick oder Retry
 * erzeugt keine Doppelbuchung, der Server meldet `duplicate`.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast-provider";
import { formatEuro, formatAmount, todayIso } from "@/lib/utils";
import { evalItemAmount, NETWORK_ERROR_MESSAGE } from "@/lib/prepayments/item-ui";
import { PAYMENT_STATUS } from "@/lib/prepayments/payment-words";
import {
  recordItemPayment,
  submitItemSelfPayment,
  recordItemProviderPayment,
  type ItemActionState,
} from "@/lib/actions/prepayment-items";

const inputCls =
  "mt-1 min-h-[44px] w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-paper-soft";

interface ModalBase {
  tripId: string;
  itemId: string;
  itemLabel: string;
  onClose: () => void;
}

function useItemAction(onClose: () => void, successMessage: string) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: (prev: ItemActionState, fd: FormData) => Promise<ItemActionState>, fd: FormData) {
    setError(null);
    startTransition(async () => {
      let res: ItemActionState;
      try {
        res = await action({ status: "idle" }, fd);
      } catch {
        // Netz weg: Modal und Eingaben bleiben, der idempotency_key auch —
        // ein Retry wird serverseitig als Duplikat erkannt, nicht doppelt gebucht.
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      toast.show(res.status === "ok" && res.duplicate ? "Schon erfasst — nichts doppelt gebucht." : successMessage, {
        variant: res.status === "ok" && res.duplicate ? "info" : "success",
      });
      onClose();
      router.refresh();
    });
  }
  return { error, setError, pending, run };
}

function AmountDateFields({
  amount,
  setAmount,
  date,
  setDate,
  noteLabel,
  note,
  setNote,
  notePlaceholder,
  idPrefix,
}: {
  amount: string;
  setAmount: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  noteLabel: string;
  note: string;
  setNote: (v: string) => void;
  notePlaceholder: string;
  idPrefix: string;
}) {
  return (
    <div className="mt-4 space-y-3">
      <label className="block text-sm" htmlFor={`${idPrefix}-amount`}>
        <span className="text-ink-soft">Betrag (€) — Rechnen möglich, z. B. 480 / 4</span>
        <input
          id={`${idPrefix}-amount`}
          inputMode="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => {
            const n = evalItemAmount(amount);
            if (n !== null) setAmount(formatAmount(n));
          }}
          className={inputCls}
        />
      </label>
      <label className="block text-sm" htmlFor={`${idPrefix}-date`}>
        <span className="text-ink-soft">Datum</span>
        <input id={`${idPrefix}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </label>
      <label className="block text-sm" htmlFor={`${idPrefix}-note`}>
        <span className="text-ink-soft">{noteLabel}</span>
        <input
          id={`${idPrefix}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={notePlaceholder}
          maxLength={120}
          className={inputCls}
        />
      </label>
    </div>
  );
}

function Footer({
  onClose,
  pending,
  disabled,
  label,
  error,
}: {
  onClose: () => void;
  pending: boolean;
  disabled: boolean;
  label: string;
  error: string | null;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          Abbrechen
        </button>
        <button
          type="submit"
          disabled={pending || disabled}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
        >
          {pending && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {label}
        </button>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Crew → vorstreckende Person
// ────────────────────────────────────────────────────────────────────────

export function ItemPaymentModal({
  tripId,
  itemId,
  itemLabel,
  onClose,
  mode,
  personId,
  personName,
  payeeName,
  soll,
  paid,
}: ModalBase & {
  mode: "record" | "self";
  /** Nur mode "record": wessen Zahlung erfasst wird. */
  personId?: string;
  personName: string;
  payeeName: string;
  soll: number;
  paid: number;
}) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState(() => formatAmount(Math.max(0, soll - paid)));
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const { error, setError, pending, run } = useItemAction(
    onClose,
    mode === "self" ? `Einzahlung ${PAYMENT_STATUS.pending}.` : "Einzahlung erfasst.",
  );
  const titleId = `item-pay-title-${itemId}`;
  const open = Math.max(0, soll - paid);
  const parsed = evalItemAmount(amount);

  function submit() {
    if (parsed === null || !(parsed > 0)) {
      setError("Bitte einen Betrag größer als 0 eingeben.");
      return;
    }
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("item_id", itemId);
    if (mode === "record" && personId) fd.set("person_id", personId);
    fd.set("amount", formatAmount(parsed));
    fd.set("date", date);
    fd.set("note", note);
    fd.set("idempotency_key", idempotencyKey);
    run(mode === "self" ? submitItemSelfPayment : recordItemPayment, fd);
  }

  return (
    <Modal onClose={onClose} labelledBy={titleId}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2 id={titleId} className="text-base font-semibold text-primary">
        {mode === "self" ? "Einzahlung melden" : `Einzahlung von ${personName} erfassen`}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {itemLabel} · Einzahlung an {payeeName} (streckt vor)
        {mode === "self" && ` — ${payeeName} bestätigt deine Meldung.`}
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2 rounded-md bg-paper-soft p-3 text-sm">
        <div><dt className="text-xs text-ink-soft">Soll</dt><dd className="font-medium">{formatEuro(soll)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Bezahlt</dt><dd className="font-medium">{formatEuro(paid)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Offen</dt><dd className="font-medium">{formatEuro(open)}</dd></div>
      </dl>
      <AmountDateFields
        idPrefix={`ipm-${itemId}`}
        amount={amount}
        setAmount={setAmount}
        date={date}
        setDate={setDate}
        noteLabel="Notiz (optional)"
        note={note}
        setNote={setNote}
        notePlaceholder="z. B. via Wero"
      />
      {parsed !== null && parsed > open + 0.005 && (
        <p role="status" className="mt-3 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          Das sind {formatEuro(parsed - open)} mehr als das Soll. Der Mehrbetrag bleibt hier stehen und wird als
          „überzahlt“ angezeigt — er muss anschließend zurückgezahlt werden.
        </p>
      )}
      <Footer
        onClose={onClose}
        pending={pending}
        disabled={parsed === null || parsed <= 0}
        label={mode === "self" ? "Melden" : "Speichern"}
        error={error}
      />
      </form>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────
// vorstreckende Person → Anbieter
// ────────────────────────────────────────────────────────────────────────

export function ItemProviderPaymentModal({
  tripId,
  itemId,
  itemLabel,
  onClose,
  total,
  providerPaid,
}: ModalBase & { total: number; providerPaid: number }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const open = Math.max(0, total - providerPaid);
  const [amount, setAmount] = useState(() => formatAmount(open));
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const { error, setError, pending, run } = useItemAction(onClose, "Überweisung an den Anbieter erfasst.");
  const titleId = `item-provider-title-${itemId}`;
  const parsed = evalItemAmount(amount);

  function submit() {
    if (parsed === null || !(parsed > 0)) {
      setError("Bitte einen Betrag größer als 0 eingeben.");
      return;
    }
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("item_id", itemId);
    fd.set("amount", formatAmount(parsed));
    fd.set("date", date);
    fd.set("description", description);
    fd.set("idempotency_key", idempotencyKey);
    run(recordItemProviderPayment, fd);
  }

  return (
    <Modal onClose={onClose} labelledBy={titleId}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2 id={titleId} className="text-base font-semibold text-primary">Überweisung an Anbieter erfassen</h2>
      <p className="mt-1 text-sm text-ink-soft">
        {itemLabel} · hier trägst du ein, was du selbst an Airline, Bahn o. Ä. überwiesen hast. Teilzahlungen sind
        möglich, die Summe darf den Betrag nicht übersteigen.
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2 rounded-md bg-paper-soft p-3 text-sm">
        <div><dt className="text-xs text-ink-soft">Betrag</dt><dd className="font-medium">{formatEuro(total)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Gezahlt</dt><dd className="font-medium">{formatEuro(providerPaid)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Noch offen</dt><dd className="font-medium">{formatEuro(open)}</dd></div>
      </dl>
      <AmountDateFields
        idPrefix={`ipp-${itemId}`}
        amount={amount}
        setAmount={setAmount}
        date={date}
        setDate={setDate}
        noteLabel="Beschreibung für die Buchungsliste (optional)"
        note={description}
        setNote={setDescription}
        notePlaceholder="z. B. Flüge, Teil 1"
      />
      {parsed !== null && parsed > open + 0.005 && (
        <p role="status" className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          Das ist mehr als der noch offene Betrag. Ist der Anbieter teurer geworden, erhöhe zuerst den Betrag
          (geht, solange noch keine Überweisung an den Anbieter gebucht ist).
        </p>
      )}
      <Footer
        onClose={onClose}
        pending={pending}
        disabled={parsed === null || parsed <= 0}
        label="Speichern"
        error={error}
      />
      </form>
    </Modal>
  );
}
