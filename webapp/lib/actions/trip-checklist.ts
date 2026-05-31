"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember } from "@/lib/auth/authz";

/**
 * Minimiert/öffnet die Törn-Fortschritt-Karte für das aktuelle Crew-Mitglied.
 * Pro Member persistiert (trip_members.checklist_collapsed_at), damit der
 * Zustand über Geräte hinweg konsistent ist. Pure Admins (kein Member) rufen
 * das nicht auf — die UI deaktiviert das Minimieren dann.
 */
export async function setChecklistCollapsed(tripId: string, collapsed: boolean) {
  const auth = await requireMember(tripId);
  if (!auth.ok) return;

  const supabase = createAdminClient();
  await supabase
    .from("trip_members")
    .update({
      checklist_collapsed_at: collapsed ? new Date().toISOString() : null,
    })
    .eq("trip_id", tripId)
    .eq("person_id", auth.personId);

  revalidatePath(`/trips/${tripId}`);
}
