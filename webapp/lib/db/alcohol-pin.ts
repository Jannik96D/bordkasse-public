import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Trinker-Flag im Profil = nur Vorbelegung (Sicherheitsrunde 2026-11, Slice 9).
 *
 * `v_transaction_shares` liest den Alkoholanteil aus
 * `COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE)` (0032). Steht in einer
 * Mitgliedschaft kein eigener Wert (`trip_members.is_alcoholic IS NULL`),
 * wirkt das PERSONEN-Flag — und zwar auf jede Buchung dieses Törns, auch
 * rückwirkend. Ohne Schutz konnte jedes Crewmitglied nach dem Törn im Profil
 * „trinke nicht" setzen und zahlte damit seinen Alkoholanteil nicht mehr
 * (die übrigen Trinker trugen ihn still mit, abgehakte Schulden stimmten
 * nicht mehr).
 *
 * Deshalb schreibt `updateProfile` VOR jeder Änderung des Personen-Flags den
 * bisherigen Wert in jede Mitgliedschaft fest, die
 *   • noch keinen eigenen Wert hat (`is_alcoholic IS NULL`) UND
 *   • deren Törn schon begonnen hat (`start_date <= heute`) ODER bereits
 *     (nicht gelöschte) Buchungen trägt.
 * Danach wirkt das Profil-Flag nur noch auf Törns, in denen es noch gar
 * keinen Saldo gibt — also als Vorbelegung für künftige Törns.
 */

export type PinCandidate = { id: string; trip_id: string };

/**
 * Reine Auswahl: welche Mitgliedschaften müssen festgeschrieben werden?
 * Ein Törn ohne bekanntes Startdatum (Lesefehler/inkonsistent) zählt als
 * begonnen — im Zweifel festschreiben (das ändert keinen Saldo).
 */
export function selectMembershipsToPin(
  candidates: PinCandidate[],
  startDateByTrip: Map<string, string>,
  tripsWithBookings: Set<string>,
  today: string,
): string[] {
  return candidates
    .filter((m) => {
      const start = startDateByTrip.get(m.trip_id);
      if (start === undefined) return true;
      return start <= today || tripsWithBookings.has(m.trip_id);
    })
    .map((m) => m.id);
}

/**
 * Schreibt `value` (das BISHERIGE Personen-Flag) in die betroffenen
 * Mitgliedschaften fest. Fail-closed: jeder Lese-/Schreibfehler liefert
 * `ok: false`, der Aufrufer bricht dann die Profil-Änderung ab.
 */
export async function pinAlcoholFlagInStartedTrips(
  supabase: Pick<SupabaseClient, "from">,
  personId: string,
  value: boolean,
  today: string,
): Promise<{ ok: true; pinned: number } | { ok: false }> {
  const { data: members, error: memErr } = await supabase
    .from("trip_members")
    .select("id, trip_id")
    .eq("person_id", personId)
    .is("is_alcoholic", null);
  if (memErr) {
    console.error("[bordkasse:db] alcohol pin members:", memErr.message);
    return { ok: false };
  }
  const candidates = (members ?? []) as PinCandidate[];
  if (candidates.length === 0) return { ok: true, pinned: 0 };

  const tripIds = [...new Set(candidates.map((m) => m.trip_id))];
  const { data: trips, error: tripErr } = await supabase
    .from("trips")
    .select("id, start_date")
    .in("id", tripIds);
  if (tripErr) {
    console.error("[bordkasse:db] alcohol pin trips:", tripErr.message);
    return { ok: false };
  }
  const startDateByTrip = new Map<string, string>();
  for (const t of (trips ?? []) as { id: string; start_date: string }[]) startDateByTrip.set(t.id, t.start_date);

  // Buchungen nur für Törns prüfen, die noch nicht begonnen haben — alle
  // anderen werden ohnehin festgeschrieben.
  const futureIds = tripIds.filter((id) => {
    const s = startDateByTrip.get(id);
    return s !== undefined && s > today;
  });
  // Je Törn ein Zähl-Query (head), statt Zeilen zu laden: ein `.in()` über
  // alle Törns könnte am PostgREST-Zeilenlimit abgeschnitten werden und
  // einen Törn mit Buchungen übersehen.
  const tripsWithBookings = new Set<string>();
  for (const tripId of futureIds) {
    const { count, error: txErr } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .is("deleted_at", null);
    if (txErr) {
      console.error("[bordkasse:db] alcohol pin transactions:", txErr.message);
      return { ok: false };
    }
    if ((count ?? 0) > 0) tripsWithBookings.add(tripId);
  }

  const pinIds = selectMembershipsToPin(candidates, startDateByTrip, tripsWithBookings, today);
  if (pinIds.length === 0) return { ok: true, pinned: 0 };

  // `is_alcoholic IS NULL` auch im UPDATE: hat der Skipper inzwischen einen
  // eigenen Wert gesetzt, gewinnt dieser.
  const { error: updErr } = await supabase
    .from("trip_members")
    .update({ is_alcoholic: value })
    .in("id", pinIds)
    .is("is_alcoholic", null);
  if (updErr) {
    console.error("[bordkasse:db] alcohol pin update:", updErr.message);
    return { ok: false };
  }
  return { ok: true, pinned: pinIds.length };
}
