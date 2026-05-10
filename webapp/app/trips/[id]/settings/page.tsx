import { getTrip, getTripMembers, getCategories } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { CrewSection } from "./crew-section";
import { CategorySection } from "./category-section";
import { ArchiveBlock } from "./archive-block";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trip, members, categories, person, admin] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCategories(id),
    getCurrentPerson(),
    isAdmin(),
  ]);
  if (!trip) return null;

  // Co-Skipper-Logik: jeder Member mit is_skipper=TRUE darf editieren,
  // ebenso jeder Admin (auch wenn er nicht Member ist).
  const myMember = members.find((m) => m.person_id === person?.id);
  const canEdit = admin || !!myMember?.is_skipper;

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-6">
      <CrewSection
        tripId={id}
        members={members}
        canEdit={canEdit}
        ownerId={trip.skipper_id}
        startDate={trip.start_date}
        endDate={trip.end_date}
      />
      <CategorySection tripId={id} categories={categories} canEdit={canEdit} />
      {canEdit && <ArchiveBlock tripId={id} archived={trip.archived} />}
    </main>
  );
}
