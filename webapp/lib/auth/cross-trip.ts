import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Cross-Trip-Schutz für Tranchen-Referenzen: stellt sicher, dass eine
 * tranche_id wirklich zu diesem Törn gehört. Verhindert, dass eine Buchung
 * in Törn A über eine untergeschobene Fremd-tranche_id mit dem Anzahlungspool
 * eines anderen Törns verknüpft wird. Ohne Tranche (null) immer ok.
 */
export async function trancheBelongsToTrip(
  supabase: AdminClient,
  trancheId: string | null | undefined,
  tripId: string,
): Promise<boolean> {
  if (!trancheId) return true;
  const { data } = await supabase
    .from("prepayment_tranches")
    .select("id")
    .eq("id", trancheId)
    .eq("trip_id", tripId)
    .maybeSingle();
  return !!data;
}

/**
 * Cross-Trip-Schutz für Personen-Referenzen: stellt sicher, dass jede
 * angegebene person_id (paid_by / participant_ids / credit_from / credit_to)
 * wirklich Crew dieses Törns ist. Verhindert, dass über eine untergeschobene
 * Fremd-person_id eine Person aus Törn B in die Bilanz von Törn A gezogen
 * wird (der Service-Role-Schreibpfad umgeht RLS, daher App-Layer-Check).
 * Leere Liste / nur null-Werte → immer ok.
 */
export async function personsBelongToTrip(
  supabase: AdminClient,
  personIds: Array<string | null | undefined>,
  tripId: string,
): Promise<boolean> {
  const ids = Array.from(new Set(personIds.filter((id): id is string => !!id)));
  if (ids.length === 0) return true;
  const { data } = await supabase
    .from("trip_members")
    .select("person_id")
    .eq("trip_id", tripId)
    .in("person_id", ids);
  const found = new Set((data ?? []).map((r) => r.person_id));
  return ids.every((id) => found.has(id));
}

export const CROSS_TRIP_PERSON_MSG =
  "Eine ausgewählte Person gehört nicht zu diesem Törn. Bitte Seite neu laden.";
