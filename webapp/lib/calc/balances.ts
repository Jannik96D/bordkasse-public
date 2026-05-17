/**
 * Aggregiert pro Person/Törn:
 *   Bezahlt + Gutschrift_gegeben - Anteil - Gutschrift_erhalten
 *
 * Spiegel der SQL-View v_balances aus 0002_views.sql.
 * Spec: docs/calculation-rules.md §Bilanz-Berechnung
 */

import { calculateShares } from "./shares";
import type { BalanceRow, Member, Transaction } from "./types";

export function computeBalances(
  transactions: Transaction[],
  members: Member[],
): BalanceRow[] {
  const N = members.length;

  // Initialisieren mit 0 für alle Crew-Mitglieder
  const rows = new Map<string, BalanceRow>(
    members.map((m) => [
      m.personId,
      {
        personId: m.personId,
        paid: 0,
        share: 0,
        creditGiven: 0,
        creditReceived: 0,
        balance: 0,
      },
    ]),
  );

  for (const tx of transactions) {
    if (tx.type === "expense") {
      // Bezahlt = volle Auslage inkl. Trinkgeld
      if (tx.paidBy && rows.has(tx.paidBy)) {
        rows.get(tx.paidBy)!.paid += tx.amount + (tx.tipAmount ?? 0);
      }
      // Anteil
      const shares = calculateShares(tx, members);
      for (const s of shares) {
        const row = rows.get(s.personId);
        if (row) row.share += s.share;
      }
    } else if (tx.type === "credit") {
      // Gutschrift gegeben
      if (tx.creditFrom && rows.has(tx.creditFrom)) {
        rows.get(tx.creditFrom)!.creditGiven += tx.amount;
      }
      if (tx.creditTo) {
        // Direkte Gutschrift
        if (rows.has(tx.creditTo)) {
          rows.get(tx.creditTo)!.creditReceived += tx.amount;
        }
      } else if (tx.creditFrom && N > 1) {
        // "An Alle": Verteilung auf alle ≠ creditFrom
        const perPerson = tx.amount / (N - 1);
        for (const m of members) {
          if (m.personId !== tx.creditFrom) {
            rows.get(m.personId)!.creditReceived += perPerson;
          }
        }
      }
    }
  }

  // Bilanz
  for (const row of rows.values()) {
    row.balance = row.paid + row.creditGiven - row.share - row.creditReceived;
  }

  return Array.from(rows.values());
}
