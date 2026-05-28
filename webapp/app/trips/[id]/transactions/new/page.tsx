import { notFound } from "next/navigation";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { getTrip, getTripMembers, getCategories } from "@/lib/queries/trips";
import { getTranches } from "@/lib/queries/prepayments";
import { TransactionForm } from "./transaction-form";

export default async function NewTransactionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trip, members, categories, person, tranches] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCategories(id),
    getCurrentPerson(),
    getTranches(id),
  ]);
  if (!trip) notFound();
  const isSkipper = person?.id === trip.skipper_id;

  if (members.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 text-center">
        <p className="font-medium text-danger">Keine Crew angelegt</p>
        <p className="mt-2 text-sm text-ink-soft">
          Bevor du Buchungen erfasst, lege mindestens eine Person in der Crew an.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <TransactionForm
        tripId={id}
        isSkipper={isSkipper}
        currentPersonId={person?.id}
        members={members.map((m) => ({
          person_id: m.person_id,
          display_name: m.display_name,
        }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
        tranches={tranches.map((t) => ({ id: t.id, label: t.label, due_date: t.due_date }))}
      />
    </main>
  );
}
