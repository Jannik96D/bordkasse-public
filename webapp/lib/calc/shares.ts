/**
 * Berechnet pro Transaktion den Anteil jedes Crew-Mitglieds.
 *
 * Spiegel der SQL-View v_transaction_shares aus 0002_views.sql.
 * Implementiert alle 4 Aufteilungs-Logiken plus Alkohol-Modifikator.
 *
 * Spec: docs/calculation-rules.md
 */

import type { Member, Share, Transaction } from "./types";

export function calculateShares(
  transaction: Transaction,
  members: Member[],
): Share[] {
  if (transaction.type !== "expense") return [];
  if (!transaction.splitType) return [];

  const { id, date, amount, alcoholAmount, splitType, participants = [] } = transaction;
  const baseAmount = amount - alcoholAmount;

  // Active-Set bestimmen
  const isActive = (m: Member): boolean => {
    switch (splitType) {
      case "equal":
        return true;
      case "on_board":
        return m.effectiveFrom <= date && m.effectiveTo >= date;
      case "time_proportional":
        return m.days > 0;
      case "individual":
        return participants.includes(m.personId);
    }
  };

  const activeSet = members.filter(isActive);
  const nActive = activeSet.length;
  const activeDays = activeSet.reduce((s, m) => s + m.days, 0);
  const drinkers = activeSet.filter((m) => m.isAlcoholic);
  const nDrinkers = drinkers.length;
  const drinkerDays = drinkers.reduce((s, m) => s + m.days, 0);

  // Hilfs-Funktionen für die zwei Komponenten
  const baseShareFor = (m: Member): number => {
    if (!isActive(m) || nActive === 0) return 0;
    switch (splitType) {
      case "equal":
      case "on_board":
      case "individual":
        return baseAmount / nActive;
      case "time_proportional":
        return activeDays > 0 ? (baseAmount * m.days) / activeDays : 0;
    }
  };

  const alcoholShareFor = (m: Member): number => {
    if (alcoholAmount <= 0 || !isActive(m)) return 0;

    // Edge-Case: keine Trinker im Active-Set → Alk auf gesamtes Active-Set
    if (nDrinkers === 0) {
      if (splitType === "time_proportional") {
        return activeDays > 0 ? (alcoholAmount * m.days) / activeDays : 0;
      }
      return alcoholAmount / nActive;
    }

    // Normalfall: nur Trinker zahlen
    if (!m.isAlcoholic) return 0;

    if (splitType === "time_proportional") {
      return drinkerDays > 0 ? (alcoholAmount * m.days) / drinkerDays : 0;
    }
    return alcoholAmount / nDrinkers;
  };

  return members
    .map((m): Share => ({
      transactionId: id,
      personId: m.personId,
      share: baseShareFor(m) + alcoholShareFor(m),
    }))
    .filter((s) => s.share > 0);
}
