import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getPrepaymentNavState } from "@/lib/queries/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { BottomNav } from "@/components/bottom-nav";
import { RealtimeTrip } from "@/components/realtime-trip";
import { Toast } from "@/components/toast";
import { TripHeader } from "@/components/trip-header";
import { PrefetchOfflineForm } from "@/components/prefetch-offline-form";

export default async function TripLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trip, members, person, admin] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
  ]);
  if (!trip) notFound();

  // Kontextuelle Anzahlungs-Navigation: nur einblenden, solange der Eintrag
  // für diese Person gerade relevant ist (eigene/Crew-Tranche offen,
  // Pending-Selbstmeldung oder Vorstrecker schuldet der Agentur noch).
  const isMyTripSkipper = !!members.find((m) => m.person_id === person?.id)?.is_skipper;
  const { show: showPrepayments } = await getPrepaymentNavState(id, {
    personId: person?.id ?? null,
    isAdmin: admin,
    isTripSkipper: isMyTripSkipper,
    tripSkipperId: trip.skipper_id,
  });

  return (
    <div className="flex min-h-full flex-col">
      <TripHeader
        tripId={id}
        tripName={trip.name}
        startDate={trip.start_date}
        endDate={trip.end_date}
        archived={!!trip.archived}
      />

      <Suspense fallback={null}>
        <Toast />
      </Suspense>

      {/* pb-20 lässt Platz für die fixed-positionierte BottomNav (≈56px + safe-area). */}
      <div className="flex-1 pb-20">{children}</div>

      <BottomNav tripId={id} showPrepayments={showPrepayments} />
      <RealtimeTrip tripId={id} currentPersonId={person?.id} />
      <PrefetchOfflineForm tripId={id} />
    </div>
  );
}
