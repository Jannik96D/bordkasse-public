"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";

/**
 * Minimiert/öffnet die Törn-Fortschritt-Karte für das aktuelle Crewmitglied.
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

/**
 * Hakt "Kaution verrechnet" in der Törn-Fortschritt-Karte manuell ab bzw.
 * wieder ab. Bewusst manuell statt automatisch erkannt — die Namens-Heuristik
 * (Kategorie /kaution/i) lief zu unsauber (umbenannte Kategorie, Kaution nur
 * per Gutschrift gegenverrechnet, gar keine eigene Buchung). Trip-Level-Fakt,
 * darum nur Skipper/Co-Skipper/Admin (wie die Sichtbarkeit der Karte).
 *
 * Liefert `{ ok }` zurück, damit die Client-Komponente bei verweigerter
 * Berechtigung den optimistischen Haken zurücksetzen kann.
 */
export async function setDepositSettled(
  tripId: string,
  settled: boolean,
): Promise<{ ok: boolean }> {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { ok: false };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("trips")
    .update({ deposit_settled_at: settled ? new Date().toISOString() : null })
    .eq("id", tripId);
  if (error) {
    console.error("[bordkasse:deposit-settled]", error.message);
    return { ok: false };
  }

  revalidatePath(`/trips/${tripId}`);
  return { ok: true };
}
