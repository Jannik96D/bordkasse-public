import { notFound, redirect } from "next/navigation";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { getTrip, getTripMembers, getCategories } from "@/lib/queries/trips";
import { getTranches, getPlan } from "@/lib/queries/prepayments";
import { createAdminClient } from "@/lib/supabase/admin";
import { round2 } from "@/lib/utils";
import { getCurrencyOptions } from "@/lib/rates/currency-options";
import {
  TransactionForm,
  type ExpenseInitial,
  type CreditInitial,
} from "../../new/transaction-form";

export const dynamic = "force-dynamic";

type SplitType = ExpenseInitial["splitType"];

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ id: string; txId: string }>;
}) {
  const { id: tripId, txId } = await params;

  const [trip, members, categories, person, tranches, plan] = await Promise.all([
    getTrip(tripId),
    getTripMembers(tripId),
    getCategories(tripId),
    getCurrentPerson(),
    getTranches(tripId),
    getPlan(tripId),
  ]);
  if (!trip) notFound();
  if (!person) redirect(`/login?redirect=/trips/${tripId}/transactions`);

  const supabase = createAdminClient();
  const { data: tx } = await supabase
    .from("transactions")
    .select(`
      id, type, date, description, amount, alcohol_amount, tip_amount, tip_distribution, split_type,
      paid_by, category_id, credit_from, credit_to, created_by, deleted_at, trip_id, tranche_id,
      original_currency, original_amount, exchange_rate, rate_source,
      transaction_participants(person_id, amount, original_amount)
    `)
    .eq("id", txId)
    .maybeSingle();

  if (!tx || tx.deleted_at) notFound();
  if (tx.trip_id !== tripId) notFound();

  // Berechtigung: Skipper, Admin oder Ersteller
  const myMember = members.find((m) => m.person_id === person.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  const admin = await isAdmin();
  const isCreator = tx.created_by === person.id;
  const canEdit = isMyTripSkipper || admin || isCreator;
  if (!canEdit) {
    redirect(`/trips/${tripId}/transactions`);
  }

  const memberOptions = members.map((m) => ({
    person_id: m.person_id,
    display_name: m.display_name,
    on_board_from: m.on_board_from,
    on_board_to: m.on_board_to,
    is_alcoholic_effective: m.is_alcoholic_effective,
  }));
  const categoryOptions = categories.map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
  }));

  // Fremdwährung (Migration 0041): Das Formular erwartet bei Fremdwährung den
  // FREMDBETRAG im Betragsfeld (der Server rechnet beim Speichern wieder in EUR
  // um). Betrag = gespeicherter original_amount; Alkohol/Trinkgeld liegen nur in
  // EUR vor und werden per Kurs zurückgerechnet (minimale Rundungsdrift ok).
  const foreignCur = (tx.original_currency ?? null) as string | null;
  const rate = tx.exchange_rate != null ? Number(tx.exchange_rate) : null;
  const isForeign = foreignCur != null && rate != null && rate > 0;
  const rateSource = (tx.rate_source ?? null) as "live" | "manual" | "bank" | null;
  const toForeign = (eur: number) => (isForeign && rate ? round2(eur / rate) : eur);

  // Buchungstyp-spezifische Initial-Werte vorbereiten
  let expenseInitial: ExpenseInitial | undefined;
  let creditInitial: CreditInitial | undefined;
  if (tx.type === "expense") {
    const rawParticipants = (tx.transaction_participants ?? []) as Array<{
      person_id: string;
      amount: number | null;
      original_amount: number | null;
    }>;
    const participantIds = rawParticipants.map((p) => p.person_id);
    const participantAmounts = rawParticipants
      .filter((p) => p.amount != null)
      .map((p) => ({
        personId: p.person_id,
        amount: isForeign ? Number(p.original_amount ?? 0) : Number(p.amount),
      }));
    expenseInitial = {
      transactionId: tx.id,
      date: tx.date,
      description: tx.description ?? "",
      categoryId: tx.category_id,
      paidBy: tx.paid_by ?? "",
      amount: isForeign ? Number(tx.original_amount ?? 0) : Number(tx.amount),
      alcoholAmount: toForeign(Number(tx.alcohol_amount ?? 0)),
      tipAmount: toForeign(Number(tx.tip_amount ?? 0)),
      tipDistribution: (tx.tip_distribution ?? "proportional") as "proportional" | "equal",
      splitType: (tx.split_type ?? "equal") as SplitType,
      participantIds,
      participantAmounts,
      trancheId: tx.tranche_id ?? null,
      originalCurrency: foreignCur,
      exchangeRate: rate,
      rateSource,
      // Bei bereits bestätigtem Bankkurs den echten Euro-Betrag (= tx.amount)
      // ins Bank-Feld vorbelegen, damit der Kurs beim erneuten Speichern hält.
      bankAmount: rateSource === "bank" ? Number(tx.amount) : null,
    };
  } else {
    creditInitial = {
      transactionId: tx.id,
      date: tx.date,
      description: tx.description ?? "",
      amount: isForeign ? Number(tx.original_amount ?? 0) : Number(tx.amount),
      creditFrom: tx.credit_from ?? "",
      creditTo: tx.credit_to,
      trancheId: tx.tranche_id ?? null,
      originalCurrency: foreignCur,
      exchangeRate: rate,
      rateSource,
      // Bei bereits bestätigtem Bankkurs den echten Euro-Betrag (= tx.amount)
      // ins Bank-Feld vorbelegen, damit der Kurs beim erneuten Speichern hält.
      bankAmount: rateSource === "bank" ? Number(tx.amount) : null,
    };
  }

  const currencyOptions = await getCurrencyOptions(tripId, trip.foreign_currencies ?? []);

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <TransactionForm
        tripId={tripId}
        isSkipper={isMyTripSkipper || admin}
        currentPersonId={person.id}
        members={memberOptions}
        categories={categoryOptions}
        tranches={tranches.map((t) => ({
          id: t.id,
          label: t.label,
          due_date: t.due_date,
          amount: plan ? round2((plan.total_amount * t.percent) / 100) : undefined,
        }))}
        canEditTranche={admin || isMyTripSkipper || (!!plan && (plan.advancer_person_id ?? trip.skipper_id) === person.id)}
        currencyOptions={currencyOptions}
        tripStart={trip.start_date}
        tripEnd={trip.end_date}
        expenseInitial={expenseInitial}
        creditInitial={creditInitial}
      />
    </main>
  );
}
