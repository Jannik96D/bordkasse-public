"use client";

import { useMemo, useState, useTransition } from "react";
import { Bell, MessageCircle, RefreshCw } from "lucide-react";
import { formatEuro, todayIso } from "@/lib/utils";
import { recordPayment, sendPrepaymentReminder } from "@/lib/actions/prepayments";
import { renderWhatsAppText, renderBulkWhatsAppText, DEFAULT_WHATSAPP_TEMPLATE } from "@/lib/prepayments/whatsapp";
import type {
  PrepaymentPlan,
  Tranche,
  CabinType,
  Obligation,
  PaymentAggregate,
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
}

export function PrepaymentMatrix({ tripId, tripName, plan, tranches, cabins, members, obligations, payments }: Props) {
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

  const cabinById = useMemo(() => new Map(cabins.map((c) => [c.id, c])), [cabins]);

  const today = todayIso();

  const cellFor = (trancheId: string, personId: string, tranchePct: number): MatrixCell => {
    const totalSoll = obligationByPerson.get(personId)?.total_amount ?? 0;
    const soll = round2((totalSoll * tranchePct) / 100);
    const paid = round2(paymentByKey.get(`${trancheId}::${personId}`) ?? 0);
    const open = round2(soll - paid);
    const tranche = tranches.find((t) => t.id === trancheId);
    const overdue = !!tranche && tranche.due_date < today && open > 0.005;
    let status: CellStatus = "open";
    if (paid > 0.005 && open <= 0.005) status = "paid";
    else if (paid > 0.005) status = "partial";
    return { trancheId, personId, soll, paid, open, status, overdue };
  };

  function openPayment(cell: MatrixCell, personName: string) {
    if (cell.soll <= 0) return;
    setPaymentModal({ cell, personName });
  }

  function bulkWhatsApp() {
    const persons = members
      .map((m) => {
        const cells = tranches.map((t) => cellFor(t.id, m.id, t.percent));
        const open = cells.reduce((s, c) => s + Math.max(0, c.open), 0);
        const firstOpen = cells.find((c) => c.open > 0.005);
        if (open <= 0.005 || !firstOpen) return null;
        const firstTranche = tranches.find((t) => t.id === firstOpen.trancheId)!;
        return {
          name: m.display_name,
          totalOpen: open,
          firstOpenTranche: { label: firstTranche.label, due_date: firstTranche.due_date },
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
      dueDate: firstTranche.due_date,
      weroId: plan.wero_id,
      weroLink: firstTranche.wero_request_link,
    });
    setWhatsAppModal({ text, title: `WhatsApp-Text für ${member.display_name}` });
  }

  return (
    <>
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
      <div className="overflow-x-auto rounded-md border border-rule bg-paper">
        <table className="w-full text-sm">
          <thead className="bg-paper-soft text-xs text-ink-soft">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-paper-soft px-3 py-2 text-left font-medium">Person</th>
              {tranches.map((t) => (
                <th key={t.id} scope="col" className="px-3 py-2 text-center font-medium">
                  <div>{t.label}</div>
                  <div className="font-normal text-ink-soft">{formatDeDate(t.due_date)} · {t.percent.toFixed(0)}%</div>
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const obl = obligationByPerson.get(m.id);
              const cabin = obl?.cabin_type_id ? cabinById.get(obl.cabin_type_id) : null;
              const rowOpen = tranches.reduce((s, t) => s + Math.max(0, cellFor(t.id, m.id, t.percent).open), 0);
              return (
                <tr key={m.id} className="border-t border-rule">
                  <th scope="row" className="sticky left-0 z-10 bg-paper px-3 py-2 text-left font-medium">
                    <div>{m.display_name}</div>
                    <div className="text-xs font-normal text-ink-soft">
                      {cabin ? `${cabin.label} · ` : ""}
                      Soll {formatEuro(obl?.total_amount ?? 0)}
                      {!m.email && <span className="ml-1 text-amber-700" title="E-Mail fehlt">⚠</span>}
                    </div>
                  </th>
                  {tranches.map((t) => {
                    const cell = cellFor(t.id, m.id, t.percent);
                    return (
                      <td key={t.id} className="px-3 py-2 text-center">
                        <button
                          onClick={() => openPayment(cell, m.display_name)}
                          className="inline-flex flex-col items-center gap-0.5 rounded px-2 py-1 hover:bg-navy-light/30"
                          aria-label={`${m.display_name}, ${t.label}: ${statusLabel(cell)}`}
                        >
                          <span className="text-lg leading-none" aria-hidden>
                            {statusSymbol(cell)}
                          </span>
                          <span className="text-xs tabular-nums text-ink-soft">
                            {cell.status === "paid" ? formatEuro(cell.soll) : `${formatEuro(cell.paid)} / ${formatEuro(cell.soll)}`}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <ReminderButton
                        tripId={tripId}
                        personId={m.id}
                        disabled={!m.email || rowOpen <= 0.005}
                        title={!m.email ? "E-Mail fehlt" : rowOpen <= 0.005 ? "Nichts offen" : "Erinnerungsmail"}
                      />
                      <button
                        onClick={() => personWhatsApp(m)}
                        disabled={rowOpen <= 0.005}
                        className="rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 disabled:opacity-40"
                        title="WhatsApp-Text"
                      >
                        <MessageCircle className="h-4 w-4" />
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

function statusSymbol(c: MatrixCell): string {
  if (c.status === "paid") return "✓";
  if (c.overdue) return "⏰";
  if (c.status === "partial") return "◐";
  return "○";
}

function statusLabel(c: MatrixCell): string {
  if (c.status === "paid") return "bezahlt";
  if (c.overdue) return "überfällig";
  if (c.status === "partial") return "teilweise bezahlt";
  return "offen";
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
      onClick={send}
      disabled={disabled || pending}
      title={msg || title}
      className="rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 disabled:opacity-40"
    >
      {pending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
      {done === "ok" && <span className="sr-only">Mail gesendet</span>}
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
