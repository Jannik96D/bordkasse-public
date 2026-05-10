import { createClient } from "@/lib/supabase/server";

/**
 * Liefert alle settled-Markierungen eines Trips als Set von Schlüsseln
 * `${fromPersonId}|${toPersonId}|${amount}` (amount auf 2 Nachkommastellen
 * gerundet, damit Vergleich mit simplify_debts-Output stabil ist).
 */
export async function getSettledDebtKeys(tripId: string): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("settled_debts")
    .select("from_person_id, to_person_id, amount")
    .eq("trip_id", tripId);

  if (error || !data) return new Set();

  return new Set(
    data.map(
      (r) =>
        `${r.from_person_id}|${r.to_person_id}|${Number(r.amount).toFixed(2)}`,
    ),
  );
}

export function debtKey(fromId: string, toId: string, amount: number): string {
  return `${fromId}|${toId}|${amount.toFixed(2)}`;
}
