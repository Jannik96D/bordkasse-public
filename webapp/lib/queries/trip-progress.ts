/**
 * Read-Pfad für die Törn-Fortschritt-Checkliste.
 *
 * Leitet die Status-Signale für computeTripProgress (lib/calc/trip-progress.ts)
 * aus dem echten Datenstand ab. Reused dabei die vorhandenen Anzahlungs- und
 * Schulden-Queries statt neu zu rechnen.
 *
 * settlement_announced_at, Start/Ende und member_count kommen vom Aufrufer
 * (schon geladenes trip/members) — werden nicht neu geladen. "Charter" wird
 * allein daraus abgeleitet, ob ein Anzahlungsplan existiert.
 */

import { readClient } from "@/lib/supabase/read-client";
import {
  getPlan,
  getCharterPaidTotal,
  getPrepaymentPoolBalances,
} from "@/lib/queries/prepayments";
import { getSimplifiedDebts } from "@/lib/queries/balances";
import { getSettledDebtKeys, debtKey } from "@/lib/queries/settled-debts";
import type { TripProgressSignals } from "@/lib/calc/trip-progress";

type Client = Awaited<ReturnType<typeof readClient>>;

export interface TripProgressInput {
  tripId: string;
  startDate: string;
  endDate: string;
  memberCount: number;
  settlementAnnounced: boolean;
}

export async function getTripProgressSignals(
  input: TripProgressInput,
): Promise<TripProgressSignals> {
  const { tripId, startDate, endDate, memberCount, settlementAnnounced } = input;

  const supabase = await readClient();

  const [
    plan,
    charterPaid,
    poolBalances,
    expenseCount,
    kautionExists,
    simplified,
    settledKeys,
  ] = await Promise.all([
    getPlan(tripId),
    getCharterPaidTotal(tripId),
    getPrepaymentPoolBalances(tripId),
    countBordkasseExpenses(supabase, tripId),
    hasKautionTransaction(supabase, tripId),
    getSimplifiedDebts(tripId),
    getSettledDebtKeys(tripId),
  ]);

  // "Charter" = es existiert ein Anzahlungsplan. Einzige Wahrheit — kein
  // separates Flag mehr.
  const isCharter = plan !== null;

  // Alle Crew-Anzahlungen eingegangen: jeder Pool-Saldo ≥ 0 (paid ≥ soll).
  // Leeres Array (kein Soll erfasst) zählt als noch nicht vollständig.
  const crewPrepaymentsComplete =
    poolBalances.length > 0 && poolBalances.every((b) => b.balance >= -0.005);

  // all_debts_settled in TS (RPC ist nur service_role; simplify_debts +
  // settled_debts sind für authenticated freigegeben).
  const allDebtsSettled = simplified.every((d) =>
    settledKeys.has(debtKey(d.from_person_id, d.to_person_id, d.amount)),
  );

  return {
    startDate,
    endDate,
    isCharter,
    crewInvited: memberCount > 1,
    charterAdvancePaid: charterPaid > 0,
    crewPrepaymentsComplete,
    firstExpenseRecorded: expenseCount > 0,
    depositSettled: kautionExists,
    settlementAnnounced,
    allDebtsSettled,
  };
}

/** Aktive Bordkasse-Ausgaben (ohne Anzahlungs-Pool). */
async function countBordkasseExpenses(
  supabase: Client,
  tripId: string,
): Promise<number> {
  const { count } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("type", "expense")
    .is("tranche_id", null)
    .is("deleted_at", null);
  return count ?? 0;
}

/** Gibt es eine aktive Buchung in einer "Kaution"-Kategorie? */
async function hasKautionTransaction(
  supabase: Client,
  tripId: string,
): Promise<boolean> {
  const { data: cats } = await supabase
    .from("trip_categories")
    .select("id, name")
    .eq("trip_id", tripId);
  const kautionIds = (cats ?? [])
    .filter((c) => /kaution/i.test(c.name ?? ""))
    .map((c) => c.id);
  if (kautionIds.length === 0) return false;

  const { count } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .in("category_id", kautionIds)
    .is("deleted_at", null);
  return (count ?? 0) > 0;
}
