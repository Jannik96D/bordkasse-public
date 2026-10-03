"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Modal } from "@/components/modal";
import { InfoTooltip } from "@/components/info-tooltip";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatEuro, formatAmount, todayIso, round2 } from "@/lib/utils";
import { submitSelfPayment } from "@/lib/actions/prepayments";
import { PersonStatusList } from "./person-status-list";
import { RecordPickerModal } from "./payment-card-parts";
import { actionableRates, buildPersonRow } from "@/lib/prepayments/person-rows";
import { toCrewDueDate, formatDeDate } from "@/lib/prepayments/dates";
import { ACTION_REPORT } from "@/lib/prepayments/payment-words";
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
  const [picker, setPicker] = useState(false);
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

  const rowData = tranches.map((t) => {
    const crewDue = toCrewDueDate(t.due_date);
    const soll = round2((totalSoll * t.percent) / 100);
    const paid = round2(paidByTranche.get(t.id) ?? 0);
    return {
      t,
      pending: pendingByTranche[t.id],
      rate: {
        key: t.id,
        label: t.label,
        detail: `Fällig ${formatDeDate(crewDue)} · ${t.percent.toFixed(0)} %`,
        soll,
        paid,
        pending: pendingByTranche[t.id]?.amount ?? 0,
        overdue: new Date(crewDue) < new Date(),
      },
    };
  });
  // Eine Zeile (nur ich) — Crew meldet pro Rate, nie doppelt bei laufender Meldung (allowWhilePending=false).
  const rows = [
    buildPersonRow({ key: "me", name: "Du", allowWhilePending: false, rates: rowData.map((r) => r.rate) }),
  ];
  const pendingList = rowData.filter((r) => r.pending).map((r) => ({ id: r.t.id, label: r.t.label, pending: r.pending }));
  const reportRate = (trancheId: string) => {
    const r = rowData.find((x) => x.t.id === trancheId);
    if (r) setModal({ trancheId, trancheLabel: r.t.label, open: Math.max(0, r.rate.soll - r.rate.paid) });
  };

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-rule bg-paper p-5">
        <p className="text-sm text-ink-soft">Dein Soll insgesamt</p>
        <p className="mt-1 text-2xl font-semibold">{formatEuro(totalSoll)}</p>
        <p className="mt-2 text-sm">
          Bezahlt: <strong>{formatEuro(totalPaid)}</strong> &middot; Offen: <strong>{formatEuro(Math.max(0, totalSoll - totalPaid))}</strong>
        </p>
      </div>

      <PersonStatusList
        rows={rows}
        ariaLabel="Dein Zahlungsstatus pro Rate"
        actionLabel={ACTION_REPORT}
        contextLabel={vocab.prepayment}
        alwaysExpanded
        onAct={(_personKey, rateKey) => {
          if (rateKey) return reportRate(rateKey);
          const openRates = actionableRates(rows[0]);
          if (openRates.length === 1) reportRate(openRates[0].key);
          else setPicker(true);
        }}
      />
      <p className="flex items-center text-xs text-ink-soft">
        Die Fristen liegen 3 Tage vor der echten Frist beim Anbieter
        <InfoTooltip
          label="Warum dieses Datum?"
          text="So kommt deine Einzahlung rechtzeitig bei der vorstreckenden Person an, die das Geld an den Anbieter weiterleitet."
        />
      </p>

      {pendingList.map((t) => (
        <p key={t.id} role="status" className="rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          <span aria-hidden="true">⏳</span> {t.label}: Du hast <strong>{formatEuro(t.pending!.amount)}</strong> am{" "}
          {formatDeDate(t.pending!.date)} gemeldet — wartet auf Bestätigung durch die vorstreckende Person.
        </p>
      ))}

      {picker && (
        <RecordPickerModal
          title={`${ACTION_REPORT}: ${vocab.prepayment}`}
          subtitle="Für welche Rate möchtest du eine Einzahlung melden?"
          options={actionableRates(rows[0]).map((r) => ({ key: r.key, label: r.label, detail: formatEuro(r.open) }))}
          onClose={() => setPicker(false)}
          onPick={(key) => {
            setPicker(false);
            reportRate(key);
          }}
        />
      )}

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
          Einzahlung melden
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {trancheLabel}: Die vorstreckende Person bestätigt deine Meldung.
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
