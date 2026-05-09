import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getTrip } from "@/lib/queries/trips";
import { BottomNav } from "@/components/bottom-nav";
import { RealtimeTrip } from "@/components/realtime-trip";
import { formatDate } from "@/lib/utils";

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
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-primary"
            aria-label="Zurück zur Übersicht"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold text-primary">{trip.name}</h1>
            <p className="truncate text-xs text-ink-soft">
              {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
              {trip.archived && " · archiviert"}
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 pb-2">{children}</div>

      <BottomNav tripId={id} />
      <RealtimeTrip tripId={id} />
    </div>
  );
}
