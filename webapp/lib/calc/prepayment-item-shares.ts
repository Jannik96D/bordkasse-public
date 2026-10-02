/**
 * Reise-Posten (Migration 0058) — reine Berechnungen, ohne DB-Zugriff.
 *
 *   • calculateItemObligations   — Soll je Person für einen Posten
 *   • allocateItemProviderShares — Anteile einer Anbieter-Zahlung
 *     (Ausgabe des Empfängers an Airline/Bahn), geschrieben als `per_person`
 *   • itemCellStatus / isItemComplete — Status für Matrix und Bilanz
 *
 * Spec: docs/prepayments.md, Abschnitt „Weitere Posten".
 */

import { allocateByWeights, calculateObligations } from "@/lib/calc/prepayment-shares";

/** Aufteilungsarten eines Postens — exakt der CHECK `pi_split_type` aus 0058. */
export type ItemSplitType = "gleichmaessig" | "zeitanteilig" | "individuell";

export interface ItemMember {
  personId: string;
  /** Bordtage, nur für „zeitanteilig". */
  days: number;
  /** Nur für „individuell": vom Skipper eingegebener Betrag pro Person. */
  manualAmount?: number;
}

export interface ItemShare {
  personId: string;
  amount: number;
}

export type ItemObligationResult =
  | { ok: true; shares: ItemShare[] }
  | { ok: false; message: string };

const euro = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;

/**
 * Soll je Person für einen Posten. Garantiert Σ Soll = `totalAmount` auf den
 * Cent:
 *   - gleichmaessig / zeitanteilig → Largest-Remainder über calculateObligations
 *     (gleiche Mechanik wie beim Charter-Soll, Fund C-3)
 *   - individuell → Pass-through der Einzelbeträge; die Summe MUSS der
 *     Posten-Summe entsprechen. Anders als beim Charter-Plan (dort läuft eine
 *     Differenz über die Bordkasse) gibt es hier keinen zweiten Topf, der eine
 *     Abweichung aufnehmen könnte: die Anbieter-Ausgabe wird nach diesem Soll
 *     verteilt, und nur bei Σ Soll = Ausgabe ist die Gesamtbilanz jeder Person
 *     nach vollständiger Zahlung exakt 0. Bewusst KEINE automatische
 *     Ableitung der Summe (Lehre aus Migration 0056: ein abgeleiteter Wert ist
 *     nach dem Speichern nicht mehr von einem gewollten unterscheidbar).
 */
export function calculateItemObligations(
  splitType: ItemSplitType,
  totalAmount: number,
  members: ItemMember[],
): ItemObligationResult {
  if (!(totalAmount > 0)) {
    return { ok: false, message: "Der Betrag des Postens muss größer als 0 € sein." };
  }
  if (members.length === 0) {
    return { ok: false, message: "Für diesen Posten ist niemand eingetragen." };
  }
  if (splitType === "individuell") {
    if (members.some((m) => (m.manualAmount ?? 0) < 0)) {
      return { ok: false, message: "Ein Einzelbetrag darf nicht negativ sein." };
    }
    const cents = members.map((m) => Math.round((m.manualAmount ?? 0) * 100));
    const sumCents = cents.reduce((s, c) => s + c, 0);
    const totalCents = Math.round(totalAmount * 100);
    if (sumCents !== totalCents) {
      return {
        ok: false,
        message: `Die Einzelbeträge ergeben ${euro(sumCents)}, der Posten kostet ${euro(totalCents)}. Bitte angleichen.`,
      };
    }
    return { ok: true, shares: members.map((m, i) => ({ personId: m.personId, amount: cents[i] / 100 })) };
  }
  const shares = calculateObligations(
    splitType,
    totalAmount,
    members.map((m) => ({ personId: m.personId, days: m.days })),
  );
  return { ok: true, shares: shares.map((s) => ({ personId: s.personId, amount: s.totalAmount })) };
}

/**
 * Verteilt eine Anbieter-Zahlung (Ausgabe mit `item_id`) auf die Personen mit
 * Soll > 0 — Grundlage für die `per_person`-Anteile in
 * `transaction_participants`.
 *
 * Warum nicht equal/time_proportional? Diese Aufteilungen leitet
 * v_transaction_shares aus ALLEN trip_members ab. Ein Mitglied ohne Posten-
 * Soll (reist selbst an) bekäme dann einen Anteil an den Flügen der anderen,
 * und bei „individuell" passten die Anteile nie zum Soll — die Gesamtbilanz
 * je Person ginge nach vollständiger Zahlung nicht auf 0 (Review-Fund
 * Bilanz, PR 270). Mit per_person = Soll ist sie es exakt.
 *
 * Teilzahlungen (zwei Tickets zu verschiedenen Zeitpunkten): verteilt wird
 * KUMULATIV — erst die bisherige Summe plus diese Zahlung nach Soll, dann
 * werden die bereits vergebenen Anteile abgezogen. So landen die Rundungs-
 * Cents nicht bei jeder Teilzahlung erneut bei denselben Personen, und
 * sobald Σ Zahlungen = Σ Soll ist, trägt jede Person exakt ihr Soll.
 * Passen die bisherigen Anteile nicht mehr zum Soll (eine Differenz würde
 * negativ oder ein Anteil liegt bei jemandem ohne Soll — praktisch nur nach
 * einem manuellen Eingriff), fällt die Funktion auf eine schlichte
 * Verteilung DIESER Zahlung zurück. Σ = `amount` gilt in beiden Zweigen
 * exakt.
 */
export function allocateItemProviderShares(
  amount: number,
  soll: ItemShare[],
  alreadyAllocated: ItemShare[] = [],
): ItemShare[] {
  const weighted = soll.filter((s) => s.amount > 0);
  if (weighted.length === 0 || !(amount > 0)) return [];
  const weights = weighted.map((s) => Math.round(s.amount * 100));

  const prevByPerson = new Map<string, number>();
  for (const a of alreadyAllocated) {
    prevByPerson.set(a.personId, (prevByPerson.get(a.personId) ?? 0) + Math.round(a.amount * 100));
  }
  const prevCents = [...prevByPerson.values()].reduce((s, c) => s + c, 0);
  const amountCents = Math.round(amount * 100);

  const toCents = (vals: number[]) => vals.map((v) => Math.round(v * 100));
  const target = toCents(allocateByWeights((prevCents + amountCents) / 100, weights));
  const prevForWeighted = weighted.map((s) => prevByPerson.get(s.personId) ?? 0);
  const prevOutside = prevCents - prevForWeighted.reduce((s, c) => s + c, 0);
  const diff = target.map((t, i) => t - prevForWeighted[i]);

  const cents =
    prevOutside === 0 && diff.every((d) => d >= 0)
      ? diff
      : toCents(allocateByWeights(amountCents / 100, weights));
  return weighted
    .map((s, i) => ({ personId: s.personId, amount: cents[i] / 100 }))
    .filter((s) => s.amount > 0);
}

/**
 * Status einer Soll-Zelle (Entscheidung M4, PR4a-Review): Über- und
 * Unterzahlung werden ausdrücklich benannt, damit die Matrix (PR4b) und die
 * Bilanz sie sichtbar machen können:
 *   open      — nichts gezahlt, nichts gemeldet
 *   pending   — nichts/zu wenig bestätigt, aber eine Selbstmeldung offen
 *   underpaid — teilweise bezahlt (bestätigt), Rest offen
 *   paid      — exakt gedeckt (auf den Cent)
 *   overpaid  — mehr bezahlt als Soll (auch bei Soll 0)
 */
export type ItemCellStatus = "open" | "pending" | "underpaid" | "paid" | "overpaid";

export function itemCellStatus(soll: number, paid: number, pending: number): ItemCellStatus {
  // „overpaid" vor der 0-Soll-Abkürzung — sonst tarnt ein fehlendes Soll jede
  // Zahlung als grünes „bezahlt" (Lehre aus der Bilanz-Seite, Migration 0057).
  if (paid > soll + 0.005) return "overpaid";
  if (paid >= soll - 0.005) return "paid";
  if (pending > 0.005) return "pending";
  if (paid > 0.005) return "underpaid";
  return "open";
}

/**
 * Ein Posten ist abgeschlossen, wenn JEDE Soll-Zelle exakt gedeckt ist (keine
 * Über-, keine Unterzahlung) UND der Anbieter exakt bezahlt ist (M4). Eine
 * Überzahlung ist kein „fertig" — das Geld muss zurück.
 */
export function isItemComplete(args: {
  totalAmount: number;
  providerPaid: number;
  cells: { soll: number; paid: number }[];
}): boolean {
  const providerOk = Math.abs(args.providerPaid - args.totalAmount) <= 0.005;
  // `every` auf einer leeren Liste wäre `true` — ein Posten ganz ohne Soll ist
  // aber nicht „abgeschlossen", sondern kaputt (Delta-Review Punkt 1).
  const hasSoll = args.cells.some((c) => c.soll > 0.005);
  const crewOk = args.cells.every((c) => Math.abs(c.paid - c.soll) <= 0.005);
  return hasSoll && providerOk && crewOk;
}
