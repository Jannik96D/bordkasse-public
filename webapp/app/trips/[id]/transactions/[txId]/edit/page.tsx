import { notFound, redirect } from "next/navigation";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { getTrip, getTripMembers, getCategories } from "@/lib/queries/trips";
import { createAdminClient } from "@/lib/supabase/admin";
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

  const [trip, members, categories, person] = await Promise.all([
    getTrip(tripId),
    getTripMembers(tripId),
    getCategories(tripId),
    getCurrentPerson(),
  ]);
  if (!trip) notFound();
  if (!person) redirect(`/login?redirect=/trips/${tripId}/transactions`);

  const supabase = createAdminClient();
  const { data: tx } = await supabase
    .from("transactions")
    .select(`
      id, type, date, description, amount, alcohol_amount, split_type,
      paid_by, category_id, credit_from, credit_to, created_by, deleted_at, trip_id,
      transaction_participants(person_id)
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
  }));
  const categoryOptions = categories.map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
  }));

  // Buchungstyp-spezifische Initial-Werte vorbereiten
  let expenseInitial: ExpenseInitial | undefined;
  let creditInitial: CreditInitial | undefined;
  if (tx.type === "expense") {
    const participantIds = (tx.transaction_participants ?? []).map(
      (p: { person_id: string }) => p.person_id,
    );
    expenseInitial = {
      transactionId: tx.id,
      date: tx.date,
      description: tx.description ?? "",
      categoryId: tx.category_id,
      paidBy: tx.paid_by ?? "",
      amount: Number(tx.amount),
      alcoholAmount: Number(tx.alcohol_amount ?? 0),
      splitType: (tx.split_type ?? "equal") as SplitType,
      participantIds,
    };
  } else {
    creditInitial = {
      transactionId: tx.id,
      date: tx.date,
      description: tx.description ?? "",
      amount: Number(tx.amount),
      creditFrom: tx.credit_from ?? "",
      creditTo: tx.credit_to,
    };
  }

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <TransactionForm
        tripId={tripId}
        isSkipper={isMyTripSkipper || admin}
        members={memberOptions}
        categories={categoryOptions}
        expenseInitial={expenseInitial}
        creditInitial={creditInitial}
      />
    </main>
  );
}
