import { readClient } from "@/lib/supabase/read-client";

export interface BalanceRow {
  person_id: string;
  display_name: string;
  paid: number;
  share: number;
  credit_given: number;
  credit_received: number;
  balance: number;
}

export async function getBalances(tripId: string): Promise<BalanceRow[]> {
  return getBalancesFromView(tripId, "v_balances");
}

/**
 * Wie getBalances, aber nur über Bordkasse-Pool-Buchungen
 * (transactions WHERE tranche_id IS NULL). Wird für die Drei-Block-
 * Bilanz benutzt, um den Anzahlungspool sauber zu trennen.
 */
export async function getBordkasseOnlyBalances(tripId: string): Promise<BalanceRow[]> {
  return getBalancesFromView(tripId, "v_balances_bordkasse_only");
}

async function getBalancesFromView(tripId: string, view: "v_balances" | "v_balances_bordkasse_only"): Promise<BalanceRow[]> {
  const supabase = await readClient();
  const { data, error } = await supabase
    .from(view)
    .select(`
      person_id, paid, share, credit_given, credit_received, balance,
      persons(display_name)
    `)
    .eq("trip_id", tripId);
  if (error || !data) return [];

  type Raw = {
    person_id: string;
    paid: number | string;
    share: number | string;
    credit_given: number | string;
    credit_received: number | string;
    balance: number | string;
    persons: { display_name: string } | { display_name: string }[] | null;
  };

  const first = <T,>(v: T | T[] | null): T | null =>
    v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

  const rows = (data as unknown as Raw[]).map((r): BalanceRow => ({
    person_id: r.person_id,
    display_name: first(r.persons)?.display_name ?? "—",
    paid: Number(r.paid),
    share: Number(r.share),
    credit_given: Number(r.credit_given),
    credit_received: Number(r.credit_received),
    balance: Number(r.balance),
  }));

  // Größtes Guthaben oben, größte Schuld unten
  rows.sort((a, b) => b.balance - a.balance);
  return rows;
}

export interface DebtTransfer {
  from_person_id: string;
  from_name: string;
  to_person_id: string;
  to_name: string;
  amount: number;
}

export async function getSimplifiedDebts(tripId: string): Promise<DebtTransfer[]> {
  const supabase = await readClient();
  const { data, error } = await supabase.rpc("simplify_debts", { p_trip_id: tripId });
  if (error || !data) return [];

  type Raw = {
    from_person_id: string;
    from_name: string;
    to_person_id: string;
    to_name: string;
    amount: number | string;
  };

  return (data as Raw[]).map((d) => ({
    from_person_id: d.from_person_id,
    from_name: d.from_name,
    to_person_id: d.to_person_id,
    to_name: d.to_name,
    amount: Number(d.amount),
  }));
}
