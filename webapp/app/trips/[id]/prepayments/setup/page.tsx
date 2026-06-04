import { redirect } from "next/navigation";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getPlan, getCabinTypes, getTranches, getObligations } from "@/lib/queries/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { type TripType } from "@/lib/trip-vocab";
import { PrepaymentWizard } from "./wizard";

export default async function PrepaymentSetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trip, members, person, admin, plan, cabins, tranches, obligations] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
    getPlan(id),
    getCabinTypes(id),
    getTranches(id),
    getObligations(id),
  ]);
  if (!trip) return null;

  const tripType: TripType = trip.trip_type === "other" ? "other" : "sailing";

  const myMember = members.find((m) => m.person_id === person?.id);
  if (!admin && !myMember?.is_skipper) {
    redirect(`/trips/${id}/prepayments`);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-4">
      <h1 className="mb-2 text-lg font-bold text-primary">Anzahlungsplan einrichten</h1>
      <p className="mb-4 text-sm text-ink-soft">
        Lege fest, wie die Gesamtsumme aufgeteilt wird und wann welche Tranche fällig ist.
      </p>

      <PrepaymentWizard
        tripId={id}
        tripType={tripType}
        members={members.map((m) => ({ id: m.person_id, display_name: m.display_name }))}
        plan={plan}
        cabins={cabins}
        tranches={tranches}
        obligations={obligations}
      />
    </main>
  );
}
