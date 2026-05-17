import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTrip } from "@/lib/queries/trips";
import { BottomNav } from "@/components/bottom-nav";
import { RealtimeTrip } from "@/components/realtime-trip";
import { Toast } from "@/components/toast";
import { TripHeader } from "@/components/trip-header";

export default async function TripLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) notFound();

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

      <BottomNav tripId={id} />
      <RealtimeTrip tripId={id} />
    </div>
  );
}
