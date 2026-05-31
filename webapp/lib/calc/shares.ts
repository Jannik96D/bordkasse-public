/**
 * Berechnet pro Transaktion den Anteil jedes Crewmitglieds.
 *
 * Spiegel der SQL-View v_transaction_shares aus 0002_views.sql / 0014_per_person.
 * Implementiert alle 5 Aufteilungs-Logiken + Alkoholmodifikator + Trinkgeld-
 * Multiplikator.
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

  const {
    id,
    date,
    amount,
    alcoholAmount,
    tipAmount = 0,
    tipDistribution = "proportional",
    splitType,
    participants = [],
    participantAmounts = [],
  } = transaction;
  const baseAmount = amount - alcoholAmount;
  const ppAmountFor = (personId: string) =>
    participantAmounts.find((p) => p.personId === personId)?.amount ?? 0;

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
      case "per_person":
        return ppAmountFor(m.personId) > 0;
    }
  };

  const activeSet = members.filter(isActive);
  const nActive = activeSet.length;
  const activeDays = activeSet.reduce((s, m) => s + m.days, 0);
  const drinkers = activeSet.filter((m) => m.isAlcoholic);
  const nDrinkers = drinkers.length;
  const drinkerDays = drinkers.reduce((s, m) => s + m.days, 0);

  const baseShareFor = (m: Member): number => {
    if (!isActive(m) || nActive === 0) return 0;
    switch (splitType) {
      case "equal":
      case "on_board":
      case "individual":
        return baseAmount / nActive;
      case "time_proportional":
        return activeDays > 0 ? (baseAmount * m.days) / activeDays : 0;
      case "per_person":
        return ppAmountFor(m.personId);
    }
  };

  const alcoholShareFor = (m: Member): number => {
    if (alcoholAmount <= 0 || !isActive(m)) return 0;
    // Bei "Pro Person" ist die Basis bereits der volle Einzelbetrag
    // (Σ pp_amount = amount), der den Alkohol mit enthält. Ein zusätzlicher
    // Alkoholanteil würde den Betrag doppelt verteilen (Σ Anteile > amount,
    // Saldosumme ≠ 0). Daher hier kein separater Alkoholanteil.
    if (splitType === "per_person") return 0;

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

  // Trinkgeld-Branching:
  //   - "Pro Person" + 'equal' → flat tip/nActive pro Beteiligter ON TOP
  //   - Sonst → multiplikativer Faktor (1 + tip/amount) auf base + alcohol
  // Beide Varianten erhalten Σ aller Anteile = amount + tipAmount.
  const useFlatTip =
    splitType === "per_person" && tipDistribution === "equal" && tipAmount > 0 && nActive > 0;
  const tipMultiplier = !useFlatTip && tipAmount > 0 && amount > 0 ? 1 + tipAmount / amount : 1;
  const flatTipShare = useFlatTip ? tipAmount / nActive : 0;

  return members
    .map((m): Share => {
      const baseSum = baseShareFor(m) + alcoholShareFor(m);
      if (useFlatTip) {
        return {
          transactionId: id,
          personId: m.personId,
          share: isActive(m) ? baseSum + flatTipShare : 0,
        };
      }
      return {
        transactionId: id,
        personId: m.personId,
        share: baseSum * tipMultiplier,
      };
    })
    .filter((s) => s.share > 0);
}
