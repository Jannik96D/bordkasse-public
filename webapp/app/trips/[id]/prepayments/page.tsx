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
  getCharterPaymentsPerTranche,
} from "@/lib/queries/prepayments";
import { getItems } from "@/lib/queries/prepayment-items";
import { itemsVisibleTo } from "@/lib/prepayments/item-ui";
import { getCategories } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { tripVocab, type TripType } from "@/lib/trip-vocab";
import { PrepaymentMatrix } from "./matrix";
import { CrewSelfView } from "./crew-self-view";
import { ItemsSection } from "./items-section";

export default async function PrepaymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [trip, members, person, admin, plan, tranches, cabins, obligations, payments, pending, charterPaid, items, categories] =
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
      getCharterPaymentsPerTranche(id),
      getItems(id),
      getCategories(id),
    ]);

  if (!trip) return null;

  const tripType: TripType = trip.trip_type === "other" ? "other" : "sailing";
  const vocab = tripVocab(tripType);

  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  // Vorstrecker darf die Matrix ebenfalls sehen + verwalten, auch wenn er
  // nicht Skipper ist (Lucas streckt für Jannik vor → Lucas hakt seine
  // eingegangenen Zahlungen ab).
  const isAdvancer = !!plan && !!person && (plan.advancer_person_id ?? trip.skipper_id) === person.id;
  const canManage = admin || isMyTripSkipper || isAdvancer;
  // Posten (PR4b): anlegen/bearbeiten/löschen nur Skipper/Admin (wie die
  // Actions). Der Empfänger eines Postens sieht seinen Posten in der
  // Vollansicht, unabhängig davon, ob er die Charter-Matrix verwalten darf.
  const canManageItems = admin || isMyTripSkipper;
  const itemMembers = members.map((m) => ({ id: m.person_id, display_name: m.display_name }));
  const itemsSection = (
    <ItemsSection
      tripId={id}
      items={items}
      members={itemMembers}
      categories={categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
      viewerId={person?.id ?? null}
      canManageItems={canManageItems}
      readOnly={!!trip.archived}
      defaultPayeeId={trip.skipper_id}
      today={new Date().toISOString().slice(0, 10)}
    />
  );

  if (!canManage) {
    // Crew-Sicht: nur eigene Zeile
    const mine = (p: { person_id: string }) => p.person_id === person?.id;
    const myPendingByTranche: Record<string, typeof pending[number] | undefined> = {};
    for (const p of pending.filter(mine)) myPendingByTranche[p.tranche_id] = p;
    return (
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-lg font-bold text-primary">Meine Anzahlungen</h1>
        {plan ? (
          <CrewSelfView
            tripId={id}
            plan={plan}
            tranches={tranches}
            obligation={obligations.find(mine) ?? null}
            payments={payments.filter(mine)}
            pendingByTranche={myPendingByTranche}
          />
        ) : itemsVisibleTo(items, person?.id ?? null).length === 0 ? (
          <p className="rounded-lg border border-rule bg-paper p-5 text-center text-sm text-ink-soft">
            Für dich gibt es hier nichts zu tun.
          </p>
        ) : null}
        {itemsSection}
      </main>
    );
  }

  // Skipper-Sicht
  if (!plan || tranches.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-4 text-lg font-bold text-primary">Anzahlungen</h1>
        <section className="rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-6 text-center">
          <p className="font-medium text-primary">Noch kein Anzahlungsplan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
            Lege Aufteilung, {vocab.cabinPlural} (optional) und Tranchen fest. Die {vocab.crew} sieht danach
            ihre Sollbeträge und kann in der Matrix abgehakt werden.
          </p>
          <Link
            href={`/trips/${id}/prepayments/setup`}
            className="mt-4 inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            Plan einrichten
          </Link>
        </section>
        {itemsSection}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-primary">Anzahlungen</h1>
        {(admin || isMyTripSkipper) && (
          <Link
            href={`/trips/${id}/prepayments/setup`}
            className="inline-flex items-center gap-1 rounded-md border border-rule px-3 py-1.5 text-sm hover:border-primary/40 hover:bg-navy-light/20"
          >
            <SettingsIcon className="h-4 w-4" />
            Plan bearbeiten
          </Link>
        )}
      </div>

      <PrepaymentMatrix
        tripId={id}
        tripName={trip.name}
        tripType={tripType}
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
        charterPaidByTranche={charterPaid}
      />
      {itemsSection}
    </main>
  );
}
