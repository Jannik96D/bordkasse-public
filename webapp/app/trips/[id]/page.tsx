import Link from "next/link";
import { Euro, ScaleIcon, Users, Plus, Wallet } from "lucide-react";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { FabAddTransaction } from "@/components/bottom-nav";
import { SettlementStatus } from "@/components/settlement-status";
import { TripProgress } from "@/components/trip-progress";
import { getTripProgressSignals } from "@/lib/queries/trip-progress";
import { computeTripProgress } from "@/lib/calc/trip-progress";
import { todayIso } from "@/lib/utils";

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
  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  const canAnnounce = admin || isMyTripSkipper;

  // Törn-Fortschritt-Karte nur für Skipper/Co-Skipper/Admin (wie der Banner).
  let progress = null;
  if (canAnnounce) {
    const signals = await getTripProgressSignals({
      tripId: id,
      startDate: trip.start_date,
      endDate: trip.end_date,
      memberCount,
      settlementAnnounced: !!trip.settlement_announced_at,
      hasCharterPrepayment: !!trip.has_charter_prepayment,
    });
    progress = computeTripProgress(signals, todayIso());
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <SettlementStatus
        tripId={id}
        endDate={trip.end_date}
        announcedAt={trip.settlement_announced_at ?? null}
        changesPendingSince={trip.changes_pending_since ?? null}
        lastResendAt={trip.last_settlement_resend_at ?? null}
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
          <Link
            href={`/trips/${id}/prepayments`}
            className="flex flex-col items-start gap-2 rounded-lg border border-rule bg-paper p-4 hover:border-primary/40 hover:bg-navy-light/20"
          >
            <Wallet className="h-5 w-5 text-primary" />
            <span className="font-medium">Anzahlungen</span>
            <span className="text-xs text-ink-soft">Tranchen + Eingangs-Erfassung</span>
          </Link>
        </div>
      </section>

      {progress && (
        <div className="mt-6">
          <TripProgress
            tripId={id}
            progress={progress}
            canCollapse={!!myMember}
            collapsed={!!myMember?.checklist_collapsed_at}
          />
        </div>
      )}

      {hasMembers && <FabAddTransaction tripId={id} />}
    </main>
  );
}
