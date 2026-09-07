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

/**
 * Prüft, ob eine Person noch eine Buchungsspur in diesem Törn hinterlässt —
 * geteilter Helfer für `removeMember` (trip-members.ts) und `replaceMember`
 * (prepayments.ts, PR 4), damit beide Pfade nicht auseinanderdriften.
 *
 * Deckt sowohl direkte Spalten-Referenzen (paid_by/credit_from/credit_to)
 * als auch `transaction_participants` ab (Fund 6, Code-Review 2026-08):
 * eine Person, die NUR über transaction_participants an einer Buchung
 * beteiligt ist (split_type='individual'/'per_person'), hinterlässt sonst
 * unbemerkt einen unallokierten Rest in v_transaction_shares (Σ balance ≠ 0).
 *
 * `includeCreditFrom` (default true) steuert, ob `credit_from = personId`
 * als Spur zählt. `replaceMember` ruft mit `false`, um VOR jeder
 * Schreib-Operation zu prüfen, ob nach dem GEDANKLICHEN Umhängen aller
 * credit_from-Zeilen (PR-4-Fix 1) noch eine Spur übrig bliebe — credit_from-
 * Zeilen werden dort umgehängt, zählen also für diese Vorab-Prüfung nicht
 * als blockierende Spur. Self-Credits (credit_from = credit_to = personId)
 * bleiben trotzdem erfasst, weil sie zusätzlich über `credit_to` matchen.
 */
export async function personHasBookingTrace(
  supabase: AdminClient,
  tripId: string,
  personId: string,
  opts: { includeCreditFrom?: boolean } = {},
): Promise<boolean> {
  const includeCreditFrom = opts.includeCreditFrom ?? true;
  const orParts = [`paid_by.eq.${personId}`, `credit_to.eq.${personId}`];
  if (includeCreditFrom) orParts.push(`credit_from.eq.${personId}`);

  const [{ count: txCount }, { count: participantCount }] = await Promise.all([
    supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .is("deleted_at", null)
      .or(orParts.join(",")),
    supabase
      .from("transaction_participants")
      .select("transaction_id, transactions!inner(trip_id, deleted_at)", { count: "exact", head: true })
      .eq("person_id", personId)
      .eq("transactions.trip_id", tripId)
      .is("transactions.deleted_at", null),
  ]);
  return (txCount ?? 0) > 0 || (participantCount ?? 0) > 0;
}
