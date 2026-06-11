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
  /** Manuell vom Skipper gesetzt (trips.deposit_settled_at IS NOT NULL). */
  depositSettled: boolean;
  /** Törn explizit „ohne Anzahlung" (trips.prepayment_declined_at IS NOT NULL). */
  prepaymentDeclined: boolean;
}

export async function getTripProgressSignals(
  input: TripProgressInput,
): Promise<TripProgressSignals> {
  const { tripId, startDate, endDate, memberCount, settlementAnnounced, depositSettled, prepaymentDeclined } = input;

  const supabase = await readClient();

  const [
    plan,
    charterPaid,
    poolBalances,
    expenseCount,
    simplified,
    settledKeys,
  ] = await Promise.all([
    getPlan(tripId),
    getCharterPaidTotal(tripId),
    getPrepaymentPoolBalances(tripId),
    countBordkasseExpenses(supabase, tripId),
    getSimplifiedDebts(tripId),
    getSettledDebtKeys(tripId),
  ]);

  // "Charter" = es existiert ein Anzahlungsplan. Einzige Wahrheit — kein
  // separates Flag mehr.
  const isCharter = plan !== null;

  // Alle Crewanzahlungen eingegangen: jeder Pool-Saldo ≥ 0 (paid ≥ soll).
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
    prepaymentDeclined,
    crewInvited: memberCount > 1,
    charterAdvancePaid: charterPaid > 0,
    crewPrepaymentsComplete,
    firstExpenseRecorded: expenseCount > 0,
    depositSettled,
    settlementAnnounced,
    allDebtsSettled,
  };
}

/** Aktive Bordkasse-Ausgaben (ohne Anzahlungspool). */
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
