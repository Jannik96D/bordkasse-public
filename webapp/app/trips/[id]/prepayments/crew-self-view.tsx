"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { Modal } from "@/components/modal";
import { InfoTooltip } from "@/components/info-tooltip";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatEuro, formatAmount, todayIso } from "@/lib/utils";
import { submitSelfPayment } from "@/lib/actions/prepayments";
import { toCrewDueDate, formatDeDate } from "@/lib/prepayments/dates";
import type {
  PrepaymentPlan,
  Tranche,
  Obligation,
  PaymentAggregate,
  PendingPayment,
} from "@/lib/queries/prepayments";

interface Props {
  tripId: string;
  plan: PrepaymentPlan | null;
  tranches: Tranche[];
  obligation: Obligation | null;
  payments: PaymentAggregate[];
  pendingByTranche: Record<string, PendingPayment | undefined>;
}

export function CrewSelfView({ tripId, plan, tranches, obligation, payments, pendingByTranche }: Props) {
  const vocab = useTripVocab();
  const [modal, setModal] = useState<{
    trancheId: string;
    trancheLabel: string;
    open: number;
  } | null>(null);

  if (!plan || tranches.length === 0 || !obligation) {
    return (
      <section className="rounded-lg border border-rule bg-paper p-5 text-center">
        <p className="text-sm text-ink-soft">
          Noch kein Anzahlungsplan vorhanden. {vocab.skipper === "Skipper" ? "Der Skipper" : "Die Reiseleitung"} richtet das ein.
        </p>
      </section>
    );
  }

  const paidByTranche = new Map<string, number>(
    payments.map((p) => [p.tranche_id, p.paid_amount]),
  );
  const totalSoll = obligation.total_amount;
  const totalPaid = [...paidByTranche.values()].reduce((a, b) => a + b, 0);

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-rule bg-paper p-5">
        <p className="text-sm text-ink-soft">Dein Soll insgesamt</p>
        <p className="mt-1 text-2xl font-semibold">{formatEuro(totalSoll)}</p>
        <p className="mt-2 text-sm">
          Bezahlt: <strong>{formatEuro(totalPaid)}</strong> &middot; Offen: <strong>{formatEuro(Math.max(0, totalSoll - totalPaid))}</strong>
        </p>
      </div>

      <ul className="space-y-2">
        {tranches.map((t) => {
          const trancheSoll = (totalSoll * t.percent) / 100;
          const paid = paidByTranche.get(t.id) ?? 0;
          const open = trancheSoll - paid;
          const pending = pendingByTranche[t.id];
          const status: "open" | "partial" | "paid" =
            paid <= 0.005 ? "open" : open <= 0.005 ? "paid" : "partial";
          const crewDue = toCrewDueDate(t.due_date);
          const isOverdue = new Date(crewDue) < new Date() && status !== "paid";
          const boxClass = pending
            ? "border-amber-400 bg-amber-50 text-base"
            : status === "paid"
              ? "border-success bg-success text-paper"
              : status === "partial"
                ? `${isOverdue ? "border-danger text-danger" : "border-primary text-primary"} bg-paper`
                : isOverdue
                  ? "border-danger bg-danger/5"
                  : "border-rule bg-paper";
          const boxContent = pending
            ? "⏳"
            : status === "paid"
              ? "✓"
              : status === "partial"
                ? "◐"
                : "";
          const ariaLabel = pending
            ? `Tranche ${t.label}: ${formatEuro(pending.amount)} gemeldet, wartet auf Bestätigung`
            : `Tranche ${t.label}: ${labelFor(status, isOverdue)}, offen ${formatEuro(Math.max(0, open))}`;
          // Offene (auch teilbezahlte) Tranche ohne laufende Meldung → die Crew
          // kann eine Zahlung melden. Gleiche Bedingung wie der „Ich habe
          // gezahlt"-Button; Box UND Button lösen denselben Dialog aus.
          const actionable = open > 0.005 && !pending;
          const reportPayment = () =>
            setModal({ trancheId: t.id, trancheLabel: t.label, open: Math.max(0, open) });
          return (
            <li key={t.id} className="rounded-lg border border-rule bg-paper p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-ink-soft">
                    Fällig {formatDeDate(crewDue)}
                    <InfoTooltip
                      label="Warum dieses Datum?"
                      text="3 Tage vor der echten Charterfrist — so kommt deine Zahlung rechtzeitig bei der vorstreckenden Person an, die das Geld an die Charteragentur weiterleitet."
                    />{" "}
                    &middot; {t.percent.toFixed(0)} %
                  </p>
                </div>
                {actionable ? (
                  <button
                    type="button"
                    onClick={reportPayment}
                    aria-label={`Zahlung melden für ${t.label}, offen ${formatEuro(Math.max(0, open))}`}
                    title="Zahlung melden"
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-md px-1.5 text-sm font-medium hover:bg-navy-light/20 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded border-2 text-sm font-bold ${boxClass}`}
                      aria-hidden="true"
                    >
                      {boxContent}
                    </span>
                    <span className="tabular-nums">{formatEuro(Math.max(0, open))}</span>
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-2 text-sm font-medium" role="status" aria-label={ariaLabel}>
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded border-2 text-sm font-bold ${boxClass}`}
                      aria-hidden="true"
                    >
                      {boxContent}
                    </span>
                    <span className="tabular-nums">{formatEuro(Math.max(0, open))}</span>
                  </span>
                )}
              </div>

              {pending && (
                <p className="mt-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
                  <span aria-hidden="true">⏳</span>{" "}
                  Du hast <strong>{formatEuro(pending.amount)}</strong> am {formatDeDate(pending.date)} gemeldet, wartet auf Bestätigung durch {vocab.skipper === "Skipper" ? "deinen Skipper" : "deine Reiseleitung"}.
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {actionable && (
                  <button
                    type="button"
                    onClick={reportPayment}
                    className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-paper hover:bg-navy-dark"
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Ich habe gezahlt
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {modal && (
        <SelfPaymentModal
          tripId={tripId}
          trancheId={modal.trancheId}
          trancheLabel={modal.trancheLabel}
          defaultAmount={modal.open}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

function SelfPaymentModal({
  tripId,
  trancheId,
  trancheLabel,
  defaultAmount,
  onClose,
}: {
  tripId: string;
  trancheId: string;
  trancheLabel: string;
  defaultAmount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const vocab = useTripVocab();
  const [amount, setAmount] = useState(formatAmount(defaultAmount));
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("tranche_id", trancheId);
    fd.set("amount", amount);
    fd.set("date", date);
    fd.set("note", note);
    startTransition(async () => {
      const res = await submitSelfPayment({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        onClose();
        router.refresh();
      }
    });
  }

  return (
    <Modal
      onClose={onClose}
      labelledBy="self-payment-title"
      backdropClassName="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
    >
        <h2 id="self-payment-title" className="text-base font-semibold text-primary">
          Zahlung melden
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {trancheLabel}: {vocab.skipper === "Skipper" ? "Dein Skipper" : "Deine Reiseleitung"} bestätigt deine Meldung.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-ink-soft">Betrag (€)</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Datum</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Notiz (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="z.B. via Wero"
              className="mt-1 min-h-[44px] w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || Number(amount.replace(",", ".")) <= 0}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-50"
            >
              {pending && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Melden
            </button>
          </div>
        </div>
    </Modal>
  );
}

function labelFor(s: "open" | "partial" | "paid", overdue: boolean): string {
  if (s === "paid") return "bezahlt";
  if (overdue) return "überfällig";
  if (s === "partial") return "teilweise bezahlt";
  return "offen";
}

