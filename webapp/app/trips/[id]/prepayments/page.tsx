import Link from "next/link";
import { Settings as SettingsIcon } from "lucide-react";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import {
  getPlan,
  getTranches,
  getCabinTypes,
  getObligations,
  getPaymentAggregates,
  getPendingPayments,
} from "@/lib/queries/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { PrepaymentMatrix } from "./matrix";
import { CrewSelfView } from "./crew-self-view";

export default async function PrepaymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [trip, members, person, admin, plan, tranches, cabins, obligations, payments, pending] =
    await Promise.all([
      getTrip(id),
      getTripMembers(id),
      getCurrentPerson(),
      isAdmin(),
      getPlan(id),
      getTranches(id),
      getCabinTypes(id),
      getObligations(id),
      getPaymentAggregates(id),
      getPendingPayments(id),
    ]);

  if (!trip) return null;

  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  const canManage = admin || isMyTripSkipper;

  if (!canManage) {
    // Crew-Sicht: nur eigene Zeile
    const mine = (p: { person_id: string }) => p.person_id === person?.id;
    const myPendingByTranche: Record<string, typeof pending[number] | undefined> = {};
    for (const p of pending.filter(mine)) myPendingByTranche[p.tranche_id] = p;
    return (
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-lg font-bold text-primary">Meine Anzahlung</h1>
        <CrewSelfView
          tripId={id}
          plan={plan}
          tranches={tranches}
          obligation={obligations.find(mine) ?? null}
          payments={payments.filter(mine)}
          pendingByTranche={myPendingByTranche}
        />
      </main>
    );
  }

  // Skipper-Sicht
  if (!plan || tranches.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-lg font-bold text-primary">Anzahlungen</h1>
        <section className="rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-6 text-center">
          <p className="font-medium text-primary">Noch kein Anzahlungs-Plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
            Lege Aufteilung, Kojen (optional) und Tranchen fest. Crew-Mitglieder sehen danach
            ihre Soll-Beträge und können in der Matrix abgehakt werden.
          </p>
          <Link
            href={`/trips/${id}/prepayments/setup`}
            className="mt-4 inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            Plan einrichten
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-primary">Anzahlungen</h1>
        <Link
          href={`/trips/${id}/prepayments/setup`}
          className="inline-flex items-center gap-1 rounded-md border border-rule px-3 py-1.5 text-sm hover:border-primary/40 hover:bg-navy-light/20"
        >
          <SettingsIcon className="h-4 w-4" />
          Plan bearbeiten
        </Link>
      </div>

      <PrepaymentMatrix
        tripId={id}
        tripName={trip.name}
        plan={plan}
        tranches={tranches}
        cabins={cabins}
        members={members.map((m) => ({
          id: m.person_id,
          display_name: m.display_name,
          email: m.email,
        }))}
        obligations={obligations}
        payments={payments}
        pending={pending}
      />
    </main>
  );
}
