import { getTrip, getTripMembers, getCategories } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { CrewSection } from "./crew-section";
import { CategorySection } from "./category-section";
import { ArchiveBlock } from "./archive-block";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trip, members, categories, person] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCategories(id),
    getCurrentPerson(),
  ]);
  if (!trip) return null;

  const isSkipper = trip.skipper_id === person?.id;

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-6">
      <CrewSection tripId={id} members={members} canEdit={isSkipper} startDate={trip.start_date} endDate={trip.end_date} />
      <CategorySection tripId={id} categories={categories} canEdit={isSkipper} />
      {isSkipper && <ArchiveBlock tripId={id} archived={trip.archived} />}
    </main>
  );
}
