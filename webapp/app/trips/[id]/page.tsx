import Link from "next/link";
import { Euro, ScaleIcon, Users, Plus } from "lucide-react";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { FabAddTransaction } from "@/components/bottom-nav";
import { SettlementStatus } from "@/components/settlement-status";

export default async function TripDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ check_settlement?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const justEditedKaution = sp.check_settlement === "1";
  const [trip, members, person, admin] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
  ]);
  if (!trip) return null;

  const memberCount = members.length;
  const hasMembers = memberCount > 0;
  const isMyTripSkipper = !!members.find((m) => m.person_id === person?.id)?.is_skipper;
  const canAnnounce = admin || isMyTripSkipper;

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <SettlementStatus
        tripId={id}
        endDate={trip.end_date}
        announcedAt={trip.settlement_announced_at ?? null}
        canAnnounce={canAnnounce}
        highlight={justEditedKaution}
      />

      <section className="rounded-lg border border-rule bg-paper p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-soft">Crew</p>
            <p className="mt-1 text-2xl font-semibold">{memberCount}</p>
          </div>
          <Link
            href={`/trips/${id}/settings`}
            className="text-sm font-medium text-primary hover:underline"
          >
            verwalten →
          </Link>
        </div>
      </section>

      {!hasMembers && (
        <section className="mt-4 rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-5 text-center">
          <Users className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="font-medium text-primary">Crew einladen</p>
          <p className="mt-1 text-sm text-ink-soft">
            Bevor du Buchungen erfasst, lege die Crew an.
          </p>
          <Link
            href={`/trips/${id}/settings`}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            <Plus className="h-4 w-4" />
            Crew hinzufügen
          </Link>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 font-semibold text-ink">Schnellzugriff</h2>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href={`/trips/${id}/transactions`}
            className="flex flex-col items-start gap-2 rounded-lg border border-rule bg-paper p-4 hover:border-primary/40 hover:bg-navy-light/20"
          >
            <Euro className="h-5 w-5 text-primary" />
            <span className="font-medium">Buchungen</span>
            <span className="text-xs text-ink-soft">Liste aller Ausgaben + Gutschriften</span>
          </Link>
          <Link
            href={`/trips/${id}/balance`}
            className="flex flex-col items-start gap-2 rounded-lg border border-rule bg-paper p-4 hover:border-primary/40 hover:bg-navy-light/20"
          >
            <ScaleIcon className="h-5 w-5 text-primary" />
            <span className="font-medium">Bilanz</span>
            <span className="text-xs text-ink-soft">Wer hat wie viel offen</span>
          </Link>
        </div>
      </section>

      {hasMembers && <FabAddTransaction tripId={id} />}
    </main>
  );
}
