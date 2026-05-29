"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, MessageCircle, RefreshCw, Check, X } from "lucide-react";
import { formatEuro, todayIso } from "@/lib/utils";
import {
  recordPayment,
  sendPrepaymentReminder,
  confirmSelfPayment,
  rejectSelfPayment,
} from "@/lib/actions/prepayments";
import { renderWhatsAppText, renderBulkWhatsAppText, DEFAULT_WHATSAPP_TEMPLATE } from "@/lib/prepayments/whatsapp";
import { toCrewDueDate } from "@/lib/prepayments/dates";
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
  plan: PrepaymentPlan;
  tranches: Tranche[];
  cabins: CabinType[];
  members: Member[];
  obligations: Obligation[];
  payments: PaymentAggregate[];
  pending: PendingPayment[];
  /** Pro Tranche: was hat der Vorstrecker schon an die Charteragentur überwiesen? */
  charterPaidByTranche: Record<string, number>;
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

export function PrepaymentMatrix({ tripId, tripName, plan, tranches, cabins, members, obligations, payments, pending, charterPaidByTranche }: Props) {
  const [paymentModal, setPaymentModal] = useState<{ cell: MatrixCell; personName: string } | null>(null);
  const [whatsAppModal, setWhatsAppModal] = useState<{ text: string; title: string } | null>(null);

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
        // Vorstrecker überspringen — er ist Empfänger, nicht Schuldner
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
      template: plan.whatsapp_template,
      tripName,
      weroId: plan.wero_id,
      weroLink: tranches[0]?.wero_request_link,
      persons,
    });
    setWhatsAppModal({ text, title: `Sammel-Text für ${persons.length} Personen` });
  }

  function personWhatsApp(member: Member) {
    const cells = tranches.map((t) => cellFor(t.id, member.id, t.percent));
    const open = cells.reduce((s, c) => s + Math.max(0, c.open), 0);
    if (open <= 0.005) return;
    const firstOpen = cells.find((c) => c.open > 0.005)!;
    const firstTranche = tranches.find((t) => t.id === firstOpen.trancheId)!;
    const text = renderWhatsAppText({
      template: plan.whatsapp_template,
      name: member.display_name,
      trancheLabel: firstTranche.label,
      tripName,
      amount: open,
      dueDate: toCrewDueDate(firstTranche.due_date),
      weroId: plan.wero_id,
      weroLink: firstTranche.wero_request_link,
    });
    setWhatsAppModal({ text, title: `WhatsApp-Text für ${member.display_name}` });
  }

  const advancerName = plan.advancer_person_id
    ? members.find((m) => m.id === plan.advancer_person_id)?.display_name ?? "Vorstrecker"
    : null;

  return (
    <>
      {advancerName && (
        <p className="mb-3 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          Vorstrecker: <strong className="text-ink">{advancerName}</strong> — alle Anzahlungen werden an diese Person verbucht. Eigener Anteil per Klick auf die Zelle als Selbst-Verrechnung abhaken (bilanzneutral, kein Mail-/WhatsApp-Versand).
        </p>
      )}

      {/* Charter-Reminder: was MUSS der Vorstrecker noch an die Charteragentur überweisen? */}
      <CharterReminderBanner
        tripId={tripId}
        tranches={tranches}
        totalAmount={plan.total_amount}
        charterPaidByTranche={charterPaidByTranche}
      />

      {/* Pending-Selbstmeldungen-Banner */}
      {pending.length > 0 && (
        <PendingBanner pending={pending} members={members} tranches={tranches} />
      )}

      {/* Header-Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={bulkWhatsApp}
          className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-sm hover:border-primary/40"
        >
          <MessageCircle className="h-4 w-4" />
          Sammel-Text für alle Offenen
        </button>
        <p className="ml-auto text-xs text-ink-soft">
          Gesamt: <strong>{formatEuro(plan.total_amount)}</strong>
        </p>
      </div>

      {/* Matrix */}
      <p className="mb-1 text-xs text-ink-soft sm:hidden" aria-hidden="true">
        ← horizontal wischen für Aktionen
      </p>
      <div className="overflow-x-auto rounded-md border border-rule bg-paper">
        <table className="w-full text-sm">
          <thead className="bg-paper-soft text-xs text-ink-soft">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-paper-soft px-2 py-2 text-left font-medium sm:px-3">Person</th>
              {tranches.map((t) => (
                <th key={t.id} scope="col" className="px-1 py-2 text-center font-medium sm:px-3">
                  <div>{t.label}</div>
                  <div className="font-normal text-ink-soft">
                    Crew bis {formatDeDate(toCrewDueDate(t.due_date))} · {t.percent.toFixed(0)}%
                  </div>
                </th>
              ))}
              <th scope="col" className="px-2 py-2 text-right font-medium sm:px-3">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const obl = obligationByPerson.get(m.id);
              const cabin = obl?.cabin_type_id ? cabinById.get(obl.cabin_type_id) : null;
              const rowOpen = tranches.reduce((s, t) => s + Math.max(0, cellFor(t.id, m.id, t.percent).open), 0);
              const isAdvancerRow = plan.advancer_person_id === m.id;
              return (
                <tr key={m.id} className="border-t border-rule">
                  <th scope="row" className="sticky left-0 z-10 bg-paper px-2 py-2 text-left font-medium sm:px-3">
                    <div className="flex items-center gap-1">
                      {m.display_name}
                      {isAdvancerRow && (
                        <span
                          className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                          title="Vorstrecker — verrechnet sich selbst"
                        >
                          Vorstrecker
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-normal text-ink-soft">
                      {cabin ? `${cabin.label} · ` : ""}
                      Soll {formatEuro(obl?.total_amount ?? 0)}
                      {!m.email && <span className="ml-1 text-amber-700" title="E-Mail fehlt">⚠</span>}
                    </div>
                  </th>
                  {tranches.map((t) => {
                    const cell = cellFor(t.id, m.id, t.percent);
                    const ariaLabel = cell.pending
                      ? `${m.display_name}, ${t.label}: ${formatEuro(cell.pending.amount)} gemeldet, wartet auf Bestätigung`
                      : `${m.display_name}, ${t.label}: ${statusLabel(cell)}, ${formatEuro(cell.paid)} von ${formatEuro(cell.soll)} bezahlt`;
                    return (
                      <td key={t.id} className="px-1 py-2 text-center sm:px-3">
                        <button
                          type="button"
                          onClick={() => openPayment(cell, m.display_name)}
                          className="inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1 rounded px-2 py-1 hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
                          aria-label={ariaLabel}
                        >
                          <StatusBox cell={cell} />
                          <span className="whitespace-nowrap text-xs tabular-nums text-ink-soft">
                            {cell.status === "paid" ? formatEuro(cell.soll) : `${formatEuro(cell.paid)} / ${formatEuro(cell.soll)}`}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-2 py-2 text-right sm:px-3">
                    <div className="inline-flex gap-1">
                      <ReminderButton
                        tripId={tripId}
                        personId={m.id}
                        disabled={!m.email || rowOpen <= 0.005 || isAdvancerRow}
                        title={
                          isAdvancerRow
                            ? "Vorstrecker erinnert sich nicht selbst — klick die Zelle zum Selbst-Verrechnen"
                            : !m.email
                              ? "E-Mail fehlt"
                              : rowOpen <= 0.005
                                ? "Nichts offen"
                                : "Erinnerungsmail"
                        }
                      />
                      <button
                        type="button"
                        onClick={() => personWhatsApp(m)}
                        disabled={rowOpen <= 0.005 || isAdvancerRow}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40"
                        title={isAdvancerRow ? "Selbst-Verrechnung statt WhatsApp" : "WhatsApp-Text"}
                        aria-label={`WhatsApp-Text für ${m.display_name}`}
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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

function statusLabel(c: MatrixCell): string {
  if (c.pending) return "gemeldet, wartet auf Bestätigung";
  if (c.status === "paid") return "bezahlt";
  if (c.overdue) return "überfällig";
  if (c.status === "partial") return "teilweise bezahlt";
  return "offen";
}

/**
 * Checkbox-artige Statusbox für eine Matrix-Zelle. Visuell deutlich als
 * „abhakbar" erkennbar (analog zur Schulden-Seite), statt einer reinen
 * Symbol-Anzeige. Klick öffnet weiterhin das Zahlungs-Modal — bei
 * Teilzahlungen / Überzahlung / Storno reicht eine binäre Checkbox nicht.
 */
function StatusBox({ cell }: { cell: MatrixCell }) {
  if (cell.pending) {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded border-2 border-amber-400 bg-amber-50 text-base leading-none"
        aria-hidden="true"
      >
        ⏳
      </span>
    );
  }
  if (cell.status === "paid") {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded border-2 border-success bg-success text-paper"
        aria-hidden="true"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3,8 7,12 13,4" />
        </svg>
      </span>
    );
  }
  if (cell.status === "partial") {
    return (
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded border-2 ${cell.overdue ? "border-danger" : "border-primary"} bg-paper text-sm font-bold ${cell.overdue ? "text-danger" : "text-primary"}`}
        aria-hidden="true"
      >
        ◐
      </span>
    );
  }
  // offen
  return (
    <span
      className={`inline-block h-6 w-6 rounded border-2 ${cell.overdue ? "border-danger bg-danger/5" : "border-rule bg-paper"}`}
      aria-hidden="true"
    />
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
  const [amount, setAmount] = useState(() => Math.max(0, cell.open).toFixed(2).replace(".", ","));
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-rule bg-paper p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-primary">Zahlung von {personName}</h2>
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
                {formatEuro(numericAmount - cell.open)} mehr als Tranche-Soll — Überschuss umbuchen?
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
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Reminder + WhatsApp
// ────────────────────────────────────────────────────────────────────────

function ReminderButton({ tripId, personId, disabled, title }: { tripId: string; personId: string; disabled: boolean; title: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<"ok" | "err" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function send() {
    setMsg(null);
    setDone(null);
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("person_id", personId);
    startTransition(async () => {
      const res = await sendPrepaymentReminder({ status: "idle" }, fd);
      if (res.status === "ok") {
        setDone("ok");
      } else if (res.status === "error") {
        setDone("err");
        setMsg(res.message);
      }
      setTimeout(() => setDone(null), 3000);
    });
  }

  return (
    <button
      type="button"
      onClick={send}
      disabled={disabled || pending}
      title={msg || title}
      aria-label={title}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40"
    >
      {pending ? (
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Bell className="h-4 w-4" aria-hidden="true" />
      )}
      {done === "ok" && <span className="sr-only">Mail gesendet</span>}
      {done === "err" && <span className="sr-only" role="alert">Fehler: {msg}</span>}
    </button>
  );
}

function WhatsAppModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-lg border border-rule bg-paper p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-primary">{title}</h2>
        <p className="mt-1 text-xs text-ink-soft">In WhatsApp einfügen.</p>
        <textarea
          readOnly
          value={text}
          rows={Math.min(20, Math.max(8, text.split("\n").length + 1))}
          className="mt-3 w-full rounded-md border border-rule p-3 font-mono text-sm"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30">
            Schließen
          </button>
          <button onClick={copy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark">
            {copied ? "✓ Kopiert" : "In Zwischenablage kopieren"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// referenced default to silence unused-warning in build pipelines that strip exports
void DEFAULT_WHATSAPP_TEMPLATE;

// ────────────────────────────────────────────────────────────────────────
// CharterReminderBanner — Erinnert den Vorstrecker an seine eigenen
// Überweisungen an die Charteragentur.
//
// Eine Tranche braucht buchhalterisch eine `transactions.expense` mit
// `tranche_id` = diese Tranche (laut Spec). Wir aggregieren diese pro
// Tranche und vergleichen mit dem Soll (total_amount × percent / 100).
// ────────────────────────────────────────────────────────────────────────

function CharterReminderBanner({
  tripId,
  tranches,
  totalAmount,
  charterPaidByTranche,
}: {
  tripId: string;
  tranches: Tranche[];
  totalAmount: number;
  charterPaidByTranche: Record<string, number>;
}) {
  if (tranches.length === 0 || totalAmount <= 0) return null;

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
    const overdue = daysLeft < 0 && remaining > 0.005;
    const soon = daysLeft >= 0 && daysLeft <= 14 && remaining > 0.005;
    return { tranche: t, soll, paid, remaining, daysLeft, overdue, soon };
  });

  const anythingOutstanding = rows.some((r) => r.remaining > 0.005);
  if (!anythingOutstanding) {
    return (
      <p className="mb-3 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
        <span aria-hidden="true">✓</span> Alle Charter-Anzahlungen sind vollständig überwiesen.
      </p>
    );
  }

  return (
    <section
      className="mb-3 rounded-md border border-rule bg-paper p-3"
      aria-label="Eigene Überweisungen an die Charteragentur"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
        Charter-Anzahlungen — deine Überweisungen
      </p>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r) => {
          const dot = r.overdue ? "⏰" : r.soon ? "⚠" : r.remaining <= 0.005 ? "✓" : "○";
          const tone = r.overdue
            ? "text-danger"
            : r.soon
              ? "text-amber-700"
              : r.remaining <= 0.005
                ? "text-success"
                : "text-ink-soft";
          const dueText = r.overdue
            ? `seit ${-r.daysLeft} Tag${r.daysLeft === -1 ? "" : "en"} überfällig`
            : r.soon
              ? `in ${r.daysLeft} Tag${r.daysLeft === 1 ? "" : "en"} fällig`
              : r.remaining <= 0.005
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
                {r.remaining > 0.005
                  ? <>noch <strong className={tone}>{formatEuro(r.remaining)}</strong> von {formatEuro(r.soll)}</>
                  : <strong className="text-success">{formatEuro(r.soll)} überwiesen</strong>
                }
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-ink-soft">
        Erfasse die Überweisung als{" "}
        <a
          href={`/trips/${tripId}/transactions/new`}
          className="text-primary underline hover:no-underline"
        >
          neue Ausgabe
        </a>
        {" "}und ordne sie der passenden Tranche zu — sie taucht dann hier mit angerechnet auf.
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
// PendingBanner — Liste der noch-nicht-bestätigten Selbstmeldungen.
// Skipper kann hier mit zwei Klicks bestätigen oder ablehnen.
// ────────────────────────────────────────────────────────────────────────

function PendingBanner({
  pending,
  members,
  tranches,
}: {
  pending: PendingPayment[];
  members: Member[];
  tranches: Tranche[];
}) {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const trancheById = new Map(tranches.map((t) => [t.id, t]));

  return (
    <section
      className="mb-4 rounded-md border-2 border-amber-300 bg-amber-50 p-3"
      role="region"
      aria-label="Selbst gemeldete Anzahlungen — warten auf Bestätigung"
    >
      <p className="mb-2 text-sm font-medium text-amber-900">
        <span aria-hidden="true">⏳</span> {pending.length} Selbstmeldung{pending.length === 1 ? "" : "en"} wartet auf Bestätigung
      </p>
      <ul className="space-y-2">
        {pending.map((p) => {
          const name = memberById.get(p.person_id)?.display_name ?? "Crew-Mitglied";
          const tranche = trancheById.get(p.tranche_id);
          return (
            <li key={p.transaction_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-paper px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <strong>{name}</strong> hat <strong className="text-primary">{formatEuro(p.amount)}</strong> für{" "}
                <strong>{tranche?.label ?? "Tranche"}</strong> gemeldet
                {p.description && <span className="block text-xs text-ink-soft">„{p.description}&ldquo;</span>}
                <span className="block text-xs text-ink-soft">{formatDeDate(p.date)}</span>
              </div>
              <PendingActions transactionId={p.transaction_id} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PendingActions({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: typeof confirmSelfPayment | typeof rejectSelfPayment) {
    setError(null);
    const fd = new FormData();
    fd.set("transaction_id", transactionId);
    startTransition(async () => {
      const res = await action({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="inline-flex gap-1">
      <button
        type="button"
        onClick={() => run(confirmSelfPayment)}
        disabled={pending}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md bg-success px-3 py-1.5 text-sm font-medium text-paper hover:bg-success/90 focus:outline-none focus:ring-2 focus:ring-success/40 disabled:opacity-50"
        aria-label="Selbstmeldung bestätigen"
        title="Bestätigen"
      >
        {pending ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={() => run(rejectSelfPayment)}
        disabled={pending}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-sm text-danger hover:border-danger/40 focus:outline-none focus:ring-2 focus:ring-danger/40 disabled:opacity-50"
        aria-label="Selbstmeldung ablehnen"
        title="Ablehnen"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      {error && <span role="alert" className="sr-only">{error}</span>}
    </div>
  );
}
