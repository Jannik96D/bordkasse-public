/**
 * Gemeinsame Personenliste für Anzahlungsplan und weitere Zahlungen (PR8) —
 * reine Logik ohne React/DB.
 *
 * Beide Karten zeigen pro Person EINE Zeile (Status + „bezahlt / Soll" +
 * Aktionsknopf). Beim Anzahlungsplan hat eine Person mehrere Raten
 * („1. Anzahlung", „Endzahlung" …); die Zeile fasst sie zusammen und klappt
 * zu den Raten auf, jede mit eigenem Status. Eine weitere Zahlung hat je
 * Person genau eine „Rate" (= keine Aufklapp-Ebene).
 *
 * Spec: docs/prepayments.md, Abschnitt „Personenliste (PR8)".
 */

import { itemCellStatus, type ItemCellStatus } from "@/lib/calc/prepayment-item-shares";
import { round2 } from "@/lib/utils";

const EPS = 0.005;

export interface RateInput {
  key: string;
  label: string;
  /** Zusatzzeile, z. B. „Crew bis 10.11. · 40 %". */
  detail: string;
  soll: number;
  paid: number;
  /** Betrag einer noch nicht bestätigten Selbstmeldung (0 = keine). */
  pending: number;
  overdue: boolean;
}

export interface RateRow extends RateInput {
  open: number;
  status: ItemCellStatus;
  actionable: boolean;
}

export interface PersonRow {
  key: string;
  name: string;
  /** z. B. „Streckt vor" — nur Anzeige. */
  badge: string | null;
  soll: number;
  paid: number;
  pending: number;
  /** Σ je Rate max(0, Soll − bezahlt): eine Überzahlung deckt keine andere Rate. */
  open: number;
  status: ItemCellStatus;
  overdue: boolean;
  actionable: boolean;
  rates: RateRow[];
}

/**
 * Rate → Zeile. `allowWhilePending`: Skipper/vorstreckende Person dürfen auch
 * bei laufender Selbstmeldung erfassen (Banner bestätigt/lehnt ab); die Crew
 * selbst darf nicht doppelt melden.
 */
export function buildRateRow(r: RateInput, allowWhilePending: boolean): RateRow {
  const open = round2(Math.max(0, r.soll - r.paid));
  return {
    ...r,
    open,
    status: itemCellStatus(r.soll, r.paid, r.pending),
    actionable: open > EPS && (allowWhilePending || r.pending <= EPS),
  };
}

export function buildPersonRow(args: {
  key: string;
  name: string;
  badge?: string | null;
  rates: RateInput[];
  allowWhilePending: boolean;
}): PersonRow {
  const rates = args.rates.map((r) => buildRateRow(r, args.allowWhilePending));
  const soll = round2(rates.reduce((s, r) => s + r.soll, 0));
  const paid = round2(rates.reduce((s, r) => s + r.paid, 0));
  const pending = round2(rates.reduce((s, r) => s + r.pending, 0));
  const open = round2(rates.reduce((s, r) => s + r.open, 0));
  // Überzahlung einer Rate wird NICHT gegen eine offene andere verrechnet
  // (der Skipper entscheidet über „Überschuss umbuchen") → bleibt sichtbar.
  const overpaidAny = rates.some((r) => r.status === "overpaid");
  const cappedPaid = rates.reduce((s, r) => s + Math.min(r.paid, r.soll), 0);
  const status: ItemCellStatus = overpaidAny ? "overpaid" : itemCellStatus(soll, cappedPaid, pending);
  return {
    key: args.key,
    name: args.name,
    badge: args.badge ?? null,
    soll,
    paid,
    pending,
    open,
    status,
    overdue: rates.some((r) => r.overdue && r.open > EPS),
    actionable: rates.some((r) => r.actionable),
    rates,
  };
}

/** Nur Personen mit Soll, Zahlung oder Meldung; alphabetisch (wie bei weiteren Zahlungen). */
export function visiblePersonRows(rows: PersonRow[]): PersonRow[] {
  return rows
    .filter((r) => r.soll > EPS || r.paid > EPS || r.pending > EPS)
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** Eine Zeile mit genau EINER Rate hat keine Aufklapp-Ebene (weitere Zahlung / Plan mit einer Rate). */
export function isExpandable(row: PersonRow): boolean {
  return row.rates.length > 1;
}

/** Offene (erfassbare) Raten einer Person — Grundlage für „Welche Rate?". */
export function actionableRates(row: PersonRow): RateRow[] {
  return row.rates.filter((r) => r.actionable);
}

/** Kennzahlen für die Zeile unter dem Fortschritt — beide Karten zeigen dieselben. */
export interface RowsSummary {
  withSoll: number;
  fullyPaid: number;
  overdue: number;
  /** Σ Überzahlung je Rate (Geld muss zurück). */
  overpaidTotal: number;
}

export function summarizeRows(rows: PersonRow[]): RowsSummary {
  const withSoll = rows.filter((r) => r.soll > EPS);
  return {
    withSoll: withSoll.length,
    fullyPaid: withSoll.filter((r) => r.open <= EPS).length,
    overdue: rows.filter((r) => r.overdue).length,
    overpaidTotal: round2(
      rows.reduce((s, r) => s + r.rates.reduce((a, x) => a + Math.max(0, x.paid - x.soll), 0), 0),
    ),
  };
}
