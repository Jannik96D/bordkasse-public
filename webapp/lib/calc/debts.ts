/**
 * Greedy-Schulden-Vereinfachung.
 *
 * Spiegel der Postgres-Function simplify_debts() aus 0003_functions.sql.
 * Spec: docs/calculation-rules.md §Schulden-Vereinfachung
 *
 * Bei N Personen sind maximal N-1 Überweisungen nötig.
 */

import type { BalanceRow, DebtTransfer } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function simplifyDebts(balances: BalanceRow[]): DebtTransfer[] {
  const debtors = balances
    .filter((b) => b.balance < -0.005)
    .map((b) => ({ personId: b.personId, open: round2(-b.balance) }))
    .sort((a, b) => b.open - a.open); // größte Schuld zuerst

  const creditors = balances
    .filter((b) => b.balance > 0.005)
    .map((b) => ({ personId: b.personId, open: round2(b.balance) }))
    .sort((a, b) => b.open - a.open); // größte Forderung zuerst

  const transfers: DebtTransfer[] = [];
  let si = 0;
  let gi = 0;

  while (si < debtors.length && gi < creditors.length) {
    const s = debtors[si];
    const g = creditors[gi];
    const amount = round2(Math.min(s.open, g.open));

    if (amount > 0) {
      transfers.push({
        fromPersonId: s.personId,
        toPersonId: g.personId,
        amount,
      });
    }

    s.open -= amount;
    g.open -= amount;

    if (s.open < 0.005) si++;
    if (g.open < 0.005) gi++;
  }

  return transfers;
}
