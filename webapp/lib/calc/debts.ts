/**
 * Greedy-Schulden-Vereinfachung.
 *
 * Spiegel der Postgres-Function simplify_debts() aus 0003_functions.sql.
 * Spec: docs/calculation-rules.md §Schulden-Vereinfachung
 *
 * Bei N Personen sind maximal N-1 Überweisungen nötig.
 */

import type { BalanceRow, DebtTransfer } from "./types";
import { round2 } from "@/lib/utils";
// round2 rundet halbe Cents von Null weg (wie Postgres ROUND) — geteilt mit
// lib/utils, damit der Mirror bei negativen .xx5-Salden nicht vom SQL abweicht
// (Fund C-6). Früher lokale Kopie mit Math.round (Richtung +∞).

export function simplifyDebts(balances: BalanceRow[]): DebtTransfer[] {
  // Salden EINMAL auf 2 NK runden — exakt wie die SQL-Quelle
  // v_balances_bordkasse_only (0026). So basieren Filter UND Transferbetrag
  // auf demselben gerundeten Wert; TS-Mirror und DB laufen nicht um einzelne
  // Cents auseinander.
  const rounded = balances.map((b) => ({
    personId: b.personId,
    balance: round2(b.balance),
  }));

  // Tiebreak (Sanierungsplan PR 9d, Fund 21): bei exakt gleichem offenem
  // Betrag lieferte `Array.sort`/Postgres' `ORDER BY` bisher keine stabile
  // Reihenfolge über mehrere Aufrufe hinweg (analog zur MATCH-Falle der
  // alten Sheets-Lösung). Da `toggleDebtSettled` gegen die LIVE neu
  // berechnete Zuordnung validiert und `settled_debts` auf (from, to,
  // amount) verschlüsselt ist, konnte ein erneuter Aufruf bei Gleichstand
  // eine andere Person-Zuordnung liefern und ein bestehendes Häkchen
  // entwerten. Fix: Person-ID als deterministischer Sekundärschlüssel
  // (aufsteigend) — muss exakt der SQL-Fassung (0055) entsprechen, sonst
  // driftet der Mirror bei Gleichstand vom echten Törn-Ergebnis ab.
  // Bewusst KEIN `localeCompare` (locale-abhängige Kollation, z. B. würde
  // eine deutsche Locale Groß-/Kleinschreibung oder Umlaute anders sortieren
  // als Postgres' Standard-Kollation) — reiner Ordinalvergleich der UUID-
  // Codepoints entspricht Postgres' `text <`-Vergleich für ASCII-Strings.
  const byIdAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const debtors = rounded
    .filter((b) => b.balance < -0.005)
    .map((b) => ({ personId: b.personId, open: -b.balance }))
    .sort((a, b) => b.open - a.open || byIdAsc(a.personId, b.personId)); // größte Schuld zuerst, dann ID

  const creditors = rounded
    .filter((b) => b.balance > 0.005)
    .map((b) => ({ personId: b.personId, open: b.balance }))
    .sort((a, b) => b.open - a.open || byIdAsc(a.personId, b.personId)); // größte Forderung zuerst, dann ID

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
