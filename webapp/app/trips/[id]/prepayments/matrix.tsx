"use client";

import { useMemo, useState, useTransition } from "react";
import { MessageCircle, RefreshCw, Sailboat, Wallet } from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";
import { Modal } from "@/components/modal";
import { NotifyCrewButton } from "./notify-crew-button";
import { PersonStatusList } from "./person-status-list";
import { buildPersonRow, summarizeRows, visiblePersonRows } from "@/lib/prepayments/person-rows";
import {
  EditButton,
  PaymentActionBar,
  PaymentCardHeader,
  OverpaidNote,
  PaymentProgress,
  PaymentSummaryLine,
  PendingReportsBanner,
  ReminderBell,
  ProviderOpenBlock,
  RecordPickerModal,
} from "./payment-card-parts";
import { planProviderRemaining, providerDueInfo, type ItemOverall } from "@/lib/prepayments/item-ui";
import { ACTION_RECORD, LABEL_PROVIDER_PAID } from "@/lib/prepayments/payment-words";
import { formatEuro, formatAmount, todayIso, round2 } from "@/lib/utils";
import {
  recordPayment,
  sendPrepaymentReminder,
  confirmSelfPayment,
  rejectSelfPayment,
} from "@/lib/actions/prepayments";
import { renderWhatsAppText, renderBulkWhatsAppText, defaultWhatsappTemplate } from "@/lib/prepayments/whatsapp";
import { toCrewDueDate, formatDeDate } from "@/lib/prepayments/dates";
import { tripVocab, type TripType, type TripVocab } from "@/lib/trip-vocab";
import type {
  PrepaymentPlan,
  Tranche,
  CabinType,
  Obligation,
  PaymentAggregate,
  PendingPayment,
} from "@/lib/queries/prepayments";

interface Member {
  id: string;
  display_name: string;
  email: string | null;
}

interface Props {
  tripId: string;
  tripName: string;
  tripType?: TripType;
  plan: PrepaymentPlan;
  tranches: Tranche[];
  cabins: CabinType[];
  members: Member[];
  obligations: Obligation[];
  payments: PaymentAggregate[];
  pending: PendingPayment[];
  /** Pro Tranche: was hat die vorstreckende Person schon an den Anbieter überwiesen? */
  charterPaidByTranche: Record<string, number>;
  /** Skipper/Admin: „Crew informieren" + „Bearbeiten" in der Aktionsleiste. */
  canEditPlan?: boolean;
  /** Archivierte Törns sind schreibgeschützt — keine Aktionsleisten-Schreibaktionen. */
  readOnly?: boolean;
  /** Server-seitig formatiertes „zuletzt informiert" (null = noch nie). */
  lastNotifiedLabel?: string | null;
}

type CellStatus = "open" | "partial" | "paid";

interface MatrixCell {
  trancheId: string;
  personId: string;
  soll: number;
  paid: number;
  open: number;
  status: CellStatus;
  overdue: boolean;
  pending: PendingPayment | null;
}

export function PrepaymentMatrix({ tripId, tripName, tripType = "sailing", plan, tranches, cabins, members, obligations, payments, pending, charterPaidByTranche, canEditPlan = false, readOnly = false, lastNotifiedLabel = null }: Props) {
  const vocab = tripVocab(tripType);
  const [paymentModal, setPaymentModal] = useState<{ cell: MatrixCell; personName: string } | null>(null);
  const [whatsAppModal, setWhatsAppModal] = useState<{ text: string; title: string } | null>(null);
  // Zweiter Schritt „Welche Rate?" — nur wenn die Person in mehreren Raten offen ist.
  const [ratePicker, setRatePicker] = useState<string | null>(null);

  const obligationByPerson = useMemo(
    () => new Map(obligations.map((o) => [o.person_id, o])),
    [obligations],
  );
  const paymentByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of payments) m.set(`${p.tranche_id}::${p.person_id}`, p.paid_amount);
    return m;
  }, [payments]);
  const pendingByKey = useMemo(() => {
    const m = new Map<string, PendingPayment>();
    for (const p of pending) m.set(`${p.tranche_id}::${p.person_id}`, p);
    return m;
  }, [pending]);

  const cabinById = useMemo(() => new Map(cabins.map((c) => [c.id, c])), [cabins]);

  const today = todayIso();

  const cellFor = (trancheId: string, personId: string, tranchePct: number): MatrixCell => {
    const totalSoll = obligationByPerson.get(personId)?.total_amount ?? 0;
    const soll = round2((totalSoll * tranchePct) / 100);
    const paid = round2(paymentByKey.get(`${trancheId}::${personId}`) ?? 0);
    const open = round2(soll - paid);
    const tranche = tranches.find((t) => t.id === trancheId);
    const overdue = !!tranche && tranche.due_date < today && open > 0.005;
    const pendingEntry = pendingByKey.get(`${trancheId}::${personId}`) ?? null;
    let status: CellStatus = "open";
    if (paid > 0.005 && open <= 0.005) status = "paid";
    else if (paid > 0.005) status = "partial";
    return { trancheId, personId, soll, paid, open, status, overdue, pending: pendingEntry };
  };

  function openPayment(cell: MatrixCell, personName: string) {
    if (cell.soll <= 0) return;
    setPaymentModal({ cell, personName });
  }

  function bulkWhatsApp() {
    const persons = members
      .map((m) => {
        // Vorstreckende Person überspringen — sie ist Empfängerin, nicht Schuldnerin
        if (plan.advancer_person_id === m.id) return null;
        const cells = tranches.map((t) => cellFor(t.id, m.id, t.percent));
        const open = cells.reduce((s, c) => s + Math.max(0, c.open), 0);
        const firstOpen = cells.find((c) => c.open > 0.005);
        if (open <= 0.005 || !firstOpen) return null;
        const firstTranche = tranches.find((t) => t.id === firstOpen.trancheId)!;
        return {
          name: m.display_name,
          totalOpen: open,
          firstOpenTranche: { label: firstTranche.label, due_date: toCrewDueDate(firstTranche.due_date) },
        };
      })
      .filter((x): x is { name: string; totalOpen: number; firstOpenTranche: { label: string; due_date: string } } => x !== null);
    const text = renderBulkWhatsAppText({
      template: plan.whatsapp_template || defaultWhatsappTemplate(vocab),
      tripName,
      weroId: plan.wero_id,
      persons,
    });
    setWhatsAppModal({ text, title: `Sammelnachricht für ${persons.length} Personen` });
  }

  function personWhatsApp(member: Member) {
    const cells = tranches.map((t) => cellFor(t.id, member.id, t.percent));
    const open = cells.reduce((s, c) => s + Math.max(0, c.open), 0);
    if (open <= 0.005) return;
    const firstOpen = cells.find((c) => c.open > 0.005)!;
    const firstTranche = tranches.find((t) => t.id === firstOpen.trancheId)!;
    const text = renderWhatsAppText({
      template: plan.whatsapp_template || defaultWhatsappTemplate(vocab),
      name: member.display_name,
      trancheLabel: firstTranche.label,
      tripName,
      amount: open,
      dueDate: toCrewDueDate(firstTranche.due_date),
      weroId: plan.wero_id,
    });
    setWhatsAppModal({ text, title: `WhatsApp-Text für ${member.display_name}` });
  }

  const advancerName = plan.advancer_person_id
    ? members.find((m) => m.id === plan.advancer_person_id)?.display_name ?? "—"
    : null;

  // Wie viel muss der Vorstrecker insgesamt noch an den Vercharterer überweisen?
  // Steuert den 🔔-Button in seiner Zeile (Mail nur sinnvoll wenn offen).
  // Gesamt offen an den Vercharterer (NICHT pro Tranche aufsummiert): eine
  // Überzahlung auf einer Tranche deckt eine andere → maßgeblich ist nur die
  // Gesamtsumme, konsistent mit der Bilanz (charterOpen = total − Σ gezahlt).
  const charterPaidTotal = tranches.reduce((sum, t) => sum + (charterPaidByTranche[t.id] ?? 0), 0);
  // Rundungsrand-sicher (3 × 33,33 € von 100,00 €): Rest aus den Raten-Soll-Beträgen, ≤ 1 ct = erledigt.
  const { outstanding: charterOutstanding, nextOpenId } = planProviderRemaining(plan.total_amount, tranches, charterPaidByTranche);

  // Pro Person einmal berechnen — von Mobile-Karten UND Desktop-Tabelle genutzt.
  const memberRows = members.map((m) => {
    const obl = obligationByPerson.get(m.id);
    const cabin = obl?.cabin_type_id ? cabinById.get(obl.cabin_type_id) : null;
    const cells = tranches.map((t) => cellFor(t.id, m.id, t.percent));
    const rowOpen = cells.reduce((s, c) => s + Math.max(0, c.open), 0);
    const isAdvancerRow = plan.advancer_person_id === m.id;
    const advancerNothingOpen = isAdvancerRow && charterOutstanding <= 0;
    return { m, obl, cabin, cells, rowOpen, isAdvancerRow, advancerNothingOpen };
  });

  // Fortschritts-Kennzahlen für den Header (#1).
  const collected = memberRows.reduce((s, r) => s + r.cells.reduce((a, c) => a + c.paid, 0), 0);
  const withObligation = memberRows.filter((r) => (r.obl?.total_amount ?? 0) > 0).length;
  const fullyPaid = memberRows.filter((r) => (r.obl?.total_amount ?? 0) > 0 && r.rowOpen <= 0.005).length;

  // Gesamtstatus wie bei den weiteren Zahlungen (gleiche Kopfzeile).
  const charterPaidCapped = Math.min(charterPaidTotal, plan.total_amount);
  const nextOpenTranche = tranches.find((t) => t.id === nextOpenId);
  const overall: ItemOverall =
    withObligation > 0 && fullyPaid === withObligation && pending.length === 0 && charterOutstanding <= 0
      ? "complete"
      : collected < plan.total_amount - 0.005 || pending.length > 0
        ? "crew_open"
        : "provider_open";
  const providerDue = providerDueInfo(
    { due_date: nextOpenTranche?.due_date ?? null, providerOpen: charterOutstanding },
    today,
    formatDeDate,
  );
  function pickPerson(personId: string) {
    const row = memberRows.find((r) => r.m.id === personId);
    if (!row) return;
    const openCells = row.cells.filter((c) => c.open > 0.005);
    if (openCells.length > 1) {
      setRatePicker(personId);
      return;
    }
    if (openCells[0]) openPayment(openCells[0], row.m.display_name);
  }
  const personRows = visiblePersonRows(
    memberRows.map(({ m, cells, isAdvancerRow }) =>
      buildPersonRow({
        key: m.id,
        name: m.display_name,
        badge: isAdvancerRow ? "Streckt vor" : null,
        // Skipper/vorstreckende Person dürfen auch bei laufender Selbstmeldung erfassen (Banner bestätigt/lehnt ab).
        allowWhilePending: true,
        rates: cells.map((c, i) => ({
          key: c.trancheId,
          label: tranches[i].label,
          detail: `${vocab.crew} bis ${formatDeDate(toCrewDueDate(tranches[i].due_date))} · ${tranches[i].percent.toFixed(0)}\u00a0%`,
          soll: c.soll,
          paid: c.paid,
          pending: c.pending?.amount ?? 0,
          overdue: c.overdue,
        })),
      }),
    ),
  );
  // Knopf der Personenzeile → wie „Einzahlung erfassen" in der Aktionsleiste (ggf. „Welche Rate?"); Knopf einer Rate → direkt deren Dialog.
  function actFromList(personId: string, trancheId?: string) {
    if (!trancheId) {
      pickPerson(personId);
      return;
    }
    const row = memberRows.find((r) => r.m.id === personId);
    const cell = row?.cells.find((c) => c.trancheId === trancheId);
    if (row && cell) openPayment(cell, row.m.display_name);
  }
  const summary = summarizeRows(personRows);
  const runPending = (action: typeof confirmSelfPayment | typeof rejectSelfPayment, id: string) => {
    const fd = new FormData();
    fd.set("transaction_id", id);
    return action({ status: "idle" }, fd);
  };
  const showActions = canEditPlan && !readOnly;
  const crewPaidLabel = `Von der ${vocab.crew} bezahlt`;

  return (
    <>
      <article aria-labelledby="plan-card-h" className="rounded-lg border border-rule bg-paper p-4">
        <PaymentCardHeader
          icon={
            tripType === "other" ? (
              <Wallet className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Sailboat className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            )
          }
          title={vocab.prepayment}
          titleId="plan-card-h"
          amount={plan.total_amount}
          meta={
            <span>
              {tranches.length === 1 ? "Frist" : "Fristen"}:{" "}
              {tranches.map((t) => `${t.label} ${formatDeDate(t.due_date)}`).join(" · ")}
            </span>
          }
          advancerName={advancerName}
          overall={overall}
        />

        <div className="mt-3 space-y-3">
          <PaymentProgress label={crewPaidLabel} done={Math.min(collected, plan.total_amount)} total={plan.total_amount} />
          <PaymentProgress
            label={LABEL_PROVIDER_PAID}
            done={charterPaidCapped}
            total={plan.total_amount}
            tone={charterPaidTotal > plan.total_amount + 0.005 ? "warn" : undefined}
          />
        </div>
        <PaymentSummaryLine
          summary={summary}
          pendingCount={pending.length}
          tooltip={
            advancerName ? (
              <InfoTooltip
                label="Wer streckt vor?"
                text="Alle Anzahlungen werden an diese Person verbucht. Den eigenen Anteil in der eigenen Zeile als Einzahlung abhaken (ändert die Bilanz nicht, kein Mail-/WhatsApp-Versand)."
              />
            ) : undefined
          }
        />
        <OverpaidNote amount={summary.overpaidTotal} />

        <ProviderOpenBlock
          open={charterOutstanding}
          due={providerDue}
          action={charterOutstanding > 0 ? { href: `/trips/${tripId}/transactions/new` } : null}
        >
          {tranches.length > 0 && plan.total_amount > 0 && (
            <ProviderTrancheDetails
              tranches={tranches}
              totalAmount={plan.total_amount}
              charterPaidByTranche={charterPaidByTranche}
            />
          )}
        </ProviderOpenBlock>

        {/* Gemeldete Einzahlungen zuerst (sofort aktionierbar). */}
        <PendingReportsBanner
          entries={pending.map((p) => ({
            id: p.transaction_id,
            who: members.find((m) => m.id === p.person_id)?.display_name ?? vocab.member,
            amount: p.amount,
            what: tranches.find((t) => t.id === p.tranche_id)?.label ?? "Tranche",
            date: p.date,
          }))}
          ariaSubject={vocab.prepayment}
          confirm={(id) => runPending(confirmSelfPayment, id)}
          reject={(id) => runPending(rejectSelfPayment, id)}
        />

      {/* Personenliste — dieselbe Komponente wie bei weiteren Zahlungen */}
      <div className="mt-3">
        <PersonStatusList
          rows={personRows}
          ariaLabel={`Zahlungsstatus pro Person für ${vocab.prepayment}`}
          actionLabel={ACTION_RECORD}
          contextLabel={vocab.prepayment}
          onAct={readOnly ? undefined : actFromList}
          renderExtras={(row) => {
            const r = memberRows.find((x) => x.m.id === row.key);
            if (!r) return null;
            return (
              <RowActions
                tripId={tripId}
                member={r.m}
                isAdvancerRow={r.isAdvancerRow}
                advancerNothingOpen={r.advancerNothingOpen}
                rowOpen={r.rowOpen}
                onWhatsApp={personWhatsApp}
                vocab={vocab}
              />
            );
          }}
        />
      </div>

      {/* Sammelnachricht — unter Tabelle/Kacheln, sobald der Überblick steht */}
      <div className="mt-3">
        <button
          onClick={bulkWhatsApp}
          className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-sm hover:border-primary/40"
        >
          <MessageCircle className="h-4 w-4" />
          Sammelnachricht für alle Offenen
        </button>
      </div>

      {/* Aktionsleiste — wie bei den weiteren Zahlungen: Crew informieren · Bearbeiten
          (Einzahlungen werden direkt in der Personenliste erfasst) */}
      <PaymentActionBar
        notify={
          showActions ? (
            <NotifyCrewButton tripId={tripId} subject="den Anzahlungsplan" lastNotifiedLabel={lastNotifiedLabel} />
          ) : null
        }
        edit={showActions ? <EditButton href={`/trips/${tripId}/prepayments/setup`} /> : null}
      />
      </article>

      {ratePicker && (() => {
        const row = memberRows.find((r) => r.m.id === ratePicker);
        if (!row) return null;
        const options = row.cells
          .filter((c) => c.open > 0.005)
          .map((c) => ({ key: c.trancheId, label: tranches.find((t) => t.id === c.trancheId)?.label ?? "Rate", detail: formatEuro(c.open) }));
        return (
          <RecordPickerModal
            title={`Welche Rate? ${row.m.display_name}`}
            subtitle="Für welche Rate möchtest du die Einzahlung erfassen?"
            options={options}
            onClose={() => setRatePicker(null)}
            onPick={(trancheId) => {
              setRatePicker(null);
              const cell = row.cells.find((c) => c.trancheId === trancheId);
              if (cell) openPayment(cell, row.m.display_name);
            }}
          />
        );
      })()}
      {paymentModal && (
        <PaymentModal
          tripId={tripId}
          tranches={tranches}
          cell={paymentModal.cell}
          personName={paymentModal.personName}
          onClose={() => setPaymentModal(null)}
        />
      )}
      {whatsAppModal && (
        <WhatsAppModal title={whatsAppModal.title} text={whatsAppModal.text} onClose={() => setWhatsAppModal(null)} />
      )}
    </>
  );
}

/** Erinnerungs- + WhatsApp-Button einer Person — von Karte und Tabelle geteilt. */
function RowActions({
  tripId,
  member,
  isAdvancerRow,
  advancerNothingOpen,
  rowOpen,
  onWhatsApp,
  vocab,
}: {
  tripId: string;
  member: Member;
  isAdvancerRow: boolean;
  advancerNothingOpen: boolean;
  rowOpen: number;
  onWhatsApp: (m: Member) => void;
  vocab: TripVocab;
}) {
  const reminderDisabled = !member.email || (isAdvancerRow ? advancerNothingOpen : rowOpen <= 0.005);
  const reminderTitle = isAdvancerRow
    ? !member.email
      ? "Für die vorstreckende Person ist keine E-Mail hinterlegt"
      : advancerNothingOpen
        ? "Alles an den Anbieter überwiesen, keine Erinnerung nötig"
        : `Übersicht an dich selbst schicken (Σ Eingänge der ${vocab.crew} / Soll Anbieter / noch zu überweisen)`
    : !member.email
      ? "E-Mail fehlt"
      : rowOpen <= 0.005
        ? "Nichts offen"
        : "Erinnerungsmail";
  return (
    <div className="inline-flex shrink-0 gap-1">
      <ReminderBell
        onSend={() => {
          const fd = new FormData();
          fd.set("trip_id", tripId);
          fd.set("person_id", member.id);
          return sendPrepaymentReminder({ status: "idle" }, fd);
        }}
        disabled={reminderDisabled}
        title={reminderTitle}
      />
      <button
        type="button"
        onClick={() => onWhatsApp(member)}
        disabled={rowOpen <= 0.005 || isAdvancerRow}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40"
        title={isAdvancerRow ? "Selbstverrechnung statt WhatsApp" : "WhatsApp-Text"}
        aria-label={`WhatsApp-Text für ${member.display_name}`}
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Payment-Modal
// ────────────────────────────────────────────────────────────────────────

function PaymentModal({
  tripId,
  tranches,
  cell,
  personName,
  onClose,
}: {
  tripId: string;
  tranches: Tranche[];
  cell: MatrixCell;
  personName: string;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(() => formatAmount(Math.max(0, cell.open)));
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const [overflowTrancheId, setOverflowTrancheId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tranche = tranches.find((t) => t.id === cell.trancheId)!;

  const numericAmount = Number(amount.replace(",", "."));
  const isOverflow = numericAmount > cell.open + 0.005;
  const overflowCandidates = tranches.filter((t) => t.id !== cell.trancheId);

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("tranche_id", cell.trancheId);
    fd.set("person_id", cell.personId);
    fd.set("amount", amount);
    fd.set("date", date);
    fd.set("note", note);
    if (isOverflow && overflowTrancheId) fd.set("overflow_tranche_id", overflowTrancheId);

    startTransition(async () => {
      const res = await recordPayment({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        onClose();
      }
    });
  }

  return (
    <Modal onClose={onClose} labelledBy="payment-modal-title">
        <h2 id="payment-modal-title" className="text-base font-semibold text-primary">Einzahlung von {personName}</h2>
        <p className="mt-1 text-sm text-ink-soft">{tranche.label} · fällig {formatDeDate(tranche.due_date)}</p>

        <dl className="mt-4 grid grid-cols-3 gap-2 rounded-md bg-paper-soft p-3 text-sm">
          <div><dt className="text-xs text-ink-soft">Soll</dt><dd className="font-medium">{formatEuro(cell.soll)}</dd></div>
          <div><dt className="text-xs text-ink-soft">Bezahlt</dt><dd className="font-medium">{formatEuro(cell.paid)}</dd></div>
          <div><dt className="text-xs text-ink-soft">Offen</dt><dd className="font-medium">{formatEuro(Math.max(0, cell.open))}</dd></div>
        </dl>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-ink-soft">Betrag (€)</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Datum</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Notiz (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="z.B. via Wero"
              className="mt-1 w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>

          {isOverflow && overflowCandidates.length > 0 && (
            <div className="rounded-md bg-paper-soft p-3 text-sm">
              <p className="font-medium text-primary">
                {formatEuro(numericAmount - cell.open)} mehr als Tranche-Soll: Überschuss umbuchen?
              </p>
              <label className="mt-2 block">
                <span className="text-xs text-ink-soft">Zusatzbetrag auf Tranche:</span>
                <select
                  value={overflowTrancheId}
                  onChange={(e) => setOverflowTrancheId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                >
                  <option value="">— als Guthaben in dieser Tranche stehen lassen —</option>
                  {overflowCandidates.map((t) => (
                    <option key={t.id} value={t.id}>{t.label} ({formatDeDate(t.due_date)})</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {error && <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30">
              Abbrechen
            </button>
            <button
              onClick={submit}
              disabled={pending || numericAmount <= 0}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-50"
            >
              {pending && <RefreshCw className="h-4 w-4 animate-spin" />}
              Speichern
            </button>
          </div>
        </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Reminder + WhatsApp
// ────────────────────────────────────────────────────────────────────────


function WhatsAppModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  function copy() {
    // navigator.clipboard ist in unsicheren Kontexten / bei verweigerter
    // Berechtigung nicht verfügbar — dann Hinweis auf manuelles Markieren.
    if (!navigator.clipboard) {
      setCopyFailed(true);
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyFailed(false);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopyFailed(true));
  }

  return (
    <Modal onClose={onClose} labelledBy="whatsapp-modal-title" className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-y-auto rounded-lg border border-rule bg-paper p-5 shadow-xl outline-none">
        <h2 id="whatsapp-modal-title" className="text-base font-semibold text-primary">{title}</h2>
        <p className="mt-1 text-xs text-ink-soft">In WhatsApp einfügen.</p>
        <textarea
          readOnly
          value={text}
          rows={Math.min(20, Math.max(8, text.split("\n").length + 1))}
          className="mt-3 w-full rounded-md border border-rule p-3 font-mono text-sm"
        />
        {copyFailed && (
          <p role="alert" className="mt-2 text-xs text-danger">
            Kopieren nicht möglich. Bitte den Text oben manuell markieren und kopieren.
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30">
            Schließen
          </button>
          <button onClick={copy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark">
            {copied ? "✓ Kopiert" : "In Zwischenablage kopieren"}
          </button>
        </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────
// ProviderTrancheDetails — Raten-Aufschlüsselung im Hinweisblock „Noch an
// Anbieter zu überweisen" (früher eigener Banner CharterReminderBanner).
//
// Eine Rate braucht buchhalterisch eine `transactions.expense` mit
// `tranche_id` = diese Rate (laut Spec). Wir aggregieren diese pro Rate und
// vergleichen mit dem Soll (total_amount × percent / 100).
// ────────────────────────────────────────────────────────────────────────

function ProviderTrancheDetails({
  tranches,
  totalAmount,
  charterPaidByTranche,
}: {
  tranches: Tranche[];
  totalAmount: number;
  charterPaidByTranche: Record<string, number>;
}) {
  const today = todayIso();
  const inDays = (iso: string) => {
    const t = new Date(`${iso}T00:00:00Z`).getTime();
    const now = new Date(`${today}T00:00:00Z`).getTime();
    return Math.round((t - now) / 86_400_000);
  };

  const rows = tranches.map((t) => {
    const soll = round2((totalAmount * t.percent) / 100);
    const paid = round2(charterPaidByTranche[t.id] ?? 0);
    const remaining = round2(soll - paid);
    const daysLeft = inDays(t.due_date);
    const overdue = daysLeft < 0 && remaining > 0.01;
    const soon = daysLeft >= 0 && daysLeft <= 14 && remaining > 0.01;
    return { tranche: t, soll, paid, remaining, daysLeft, overdue, soon };
  });

  return (
    <details className="group mt-2 [&_summary::-webkit-details-marker]:hidden">
      <summary
        className="inline-flex min-h-[44px] cursor-pointer items-center text-xs text-primary underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
        aria-label="Aufschlüsselung nach Raten — aufklappen"
      >
        Aufschlüsselung nach Raten
      </summary>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r) => {
          const dot = r.overdue ? "⏰" : r.soon ? "⚠" : r.remaining <= 0.01 ? "✓" : "○";
          const tone = r.overdue
            ? "text-danger"
            : r.soon
              ? "text-amber-700"
              : r.remaining <= 0.01
                ? "text-success"
                : "text-ink-soft";
          const dueText = r.overdue
            ? `seit ${-r.daysLeft} Tag${r.daysLeft === -1 ? "" : "en"} überfällig`
            : r.soon
              ? `in ${r.daysLeft} Tag${r.daysLeft === 1 ? "" : "en"} fällig`
              : r.remaining <= 0.01
                ? "überwiesen"
                : `fällig ${formatDeDate(r.tranche.due_date)}`;
          return (
            <li key={r.tranche.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className={`inline-flex items-center gap-2 ${tone}`}>
                <span className="text-base leading-none" aria-hidden="true">{dot}</span>
                <span className="font-medium text-ink">{r.tranche.label}</span>
                <span>·</span>
                <span>{dueText}</span>
              </span>
              <span className="tabular-nums text-ink-soft">
                {r.remaining > 0.01
                  ? <>noch <strong className={tone}>{formatEuro(r.remaining)}</strong> von {formatEuro(r.soll)}</>
                  : <strong className="text-success">{formatEuro(r.soll)} überwiesen</strong>
                }
              </span>
            </li>
          );
        })}
      </ul>
      <p className="pt-2 text-xs text-ink-soft">
        Die Überweisung als{" "}
        neue Ausgabe erfassen und der Rate zuordnen — sie wird dann hier angerechnet und reduziert den offenen Betrag.
      </p>
    </details>
  );
}
