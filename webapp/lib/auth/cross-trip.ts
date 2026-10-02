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
 * Cross-Trip-Schutz für Reise-Posten (Migration 0058): gehört `itemId` zu
 * diesem Törn? Die DB erzwingt das für Buchungen ohnehin per Composite-FK
 * (`tx_item_fk`) — der App-Check liefert eine verständliche Meldung statt
 * eines nackten 23503 und schützt die Posten-Actions, die vor jedem Schreiben
 * Soll/Empfänger des Postens lesen. FAIL-CLOSED: ein Lesefehler gilt als
 * „gehört nicht dazu", weil das Ergebnis eine Schreibfreigabe ist.
 */
export async function itemBelongsToTrip(
  supabase: AdminClient,
  itemId: string | null | undefined,
  tripId: string,
): Promise<boolean> {
  if (!itemId) return true;
  const { data, error } = await supabase
    .from("prepayment_items")
    .select("id")
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (error) {
    console.error("[bordkasse:db] itemBelongsToTrip:", error.message);
    return false;
  }
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
  opts: { includeCreditFrom?: boolean; excludeItemParticipants?: boolean } = {},
): Promise<boolean> {
  const includeCreditFrom = opts.includeCreditFrom ?? true;
  const orParts = [`paid_by.eq.${personId}`, `credit_to.eq.${personId}`];
  if (includeCreditFrom) orParts.push(`credit_from.eq.${personId}`);

  // `excludeItemParticipants`: Anteile an Posten-Anbieterzahlungen (Ausgabe
  // mit item_id, per_person = Soll) zählen NICHT als Spur. replaceMember
  // hängt sie zusammen mit dem Posten-Soll auf die neue Person um — sonst
  // wäre der klassische Wechsel vor Törnbeginn blockiert, sobald die Flüge
  // bezahlt sind (also fast immer).
  let partQuery = supabase
    .from("transaction_participants")
    .select("transaction_id, transactions!inner(trip_id, deleted_at, item_id)", { count: "exact", head: true })
    .eq("person_id", personId)
    .eq("transactions.trip_id", tripId)
    .is("transactions.deleted_at", null);
  if (opts.excludeItemParticipants) partQuery = partQuery.is("transactions.item_id", null);

  const [txRes, partRes, payeeRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .is("deleted_at", null)
      .or(orParts.join(",")),
    partQuery,
    // Posten-Empfänger (0058, PR4): auch OHNE jede Buchung ist die Person
    // Spur — die Crew zahlt ihr Geld an sie (credit_to). Verschwände ihre
    // Mitgliedschaft, fielen diese Gutschriften aus der mitgliedschafts-
    // getriebenen v_balances (Σ ≠ 0), und `payee_person_id` (RESTRICT)
    // zeigte auf eine Nicht-Crew-Person.
    supabase
      .from("prepayment_items")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("payee_person_id", personId),
  ]);

  // FAIL-CLOSED (Grill-Fund P7): ein verschluckter Query-Fehler lieferte
  // vorher `count: undefined → 0 → "keine Spur"`. Beide Aufrufer nutzen das
  // Ergebnis als Freigabe zum LÖSCHEN der Mitgliedschaft — ein transienter
  // DB-Fehler hätte also eine Person mit lebenden `paid_by`-Zeilen entfernt.
  // Deren `paid` fällt dann aus v_balances heraus, während die Anteile
  // bleiben: Σ Bilanz ≠ 0 auf Dauer, `all_debts_settled` nie wahr, der Törn
  // dauerhaft nicht purgebar. Im Zweifel lieber „hat eine Spur" melden und
  // den Wechsel ablehnen.
  if (txRes.error || partRes.error || payeeRes.error) {
    console.error(
      "[bordkasse:db] personHasBookingTrace:",
      txRes.error?.message ?? partRes.error?.message ?? payeeRes.error?.message,
    );
    return true;
  }
  return (txRes.count ?? 0) > 0 || (partRes.count ?? 0) > 0 || (payeeRes.count ?? 0) > 0;
}
