/**
 * Berechnet Sollbeträge pro Person für den Anzahlungsplan eines Trips.
 *
 * Vier Aufteilungsmethoden:
 *   - gleichmaessig:  total_amount gleichmäßig auf alle Crew
 *   - zeitanteilig:   nach Bordtagen
 *   - individuell:    explizit pro Person (kommt aus dem Skipper-Input, hier nur pass-through)
 *   - kojen:          jede Person bekommt ihre cabin_type.price_per_person
 *
 * Wird im Render-Pfad UND in Vitest verwendet.
 * Spec: docs/prepayments.md §Aufteilungsmethoden
 */

import type { PrepaymentSplitMethod } from "@/lib/validation/prepayment-schema";

export interface PrepaymentMember {
  personId: string;
  days: number; // für 'zeitanteilig'
  cabinTypeId?: string | null;
  /** Bei 'individuell' liefert der Skipper den Betrag direkt. */
  manualAmount?: number;
}

export interface PrepaymentCabin {
  id: string;
  pricePerPerson: number;
  capacity: number;
}

export interface PrepaymentTranche {
  id: string;
  percent: number;
}

export interface ObligationShare {
  personId: string;
  totalAmount: number;
  cabinTypeId?: string | null;
}

export function calculateObligations(
  splitMethod: PrepaymentSplitMethod,
  totalAmount: number,
  members: PrepaymentMember[],
  cabins: PrepaymentCabin[] = [],
): ObligationShare[] {
  if (members.length === 0) return [];

  switch (splitMethod) {
    case "gleichmaessig": {
      // Largest-Remainder statt round2 pro Kopf (Fund C-3): sonst wäre
      // Σ ≠ total_amount (z. B. 1000/3 → 3×333,33 = 999,99) und der Vorstrecker
      // sammelte einen Cent zu wenig ein, obwohl die Matrix „voll bezahlt" zeigt.
      const shares = allocateByWeights(totalAmount, members.map(() => 1));
      return members.map((m, i) => ({ personId: m.personId, totalAmount: shares[i] }));
    }
    case "zeitanteilig": {
      const totalDays = members.reduce((s, m) => s + Math.max(0, m.days), 0);
      const weights = totalDays === 0 ? members.map(() => 1) : members.map((m) => Math.max(0, m.days));
      const shares = allocateByWeights(totalAmount, weights);
      return members.map((m, i) => ({ personId: m.personId, totalAmount: shares[i] }));
    }
    case "individuell": {
      return members.map((m) => ({
        personId: m.personId,
        totalAmount: round2(m.manualAmount ?? 0),
      }));
    }
    case "kojen": {
      const cabinById = new Map(cabins.map((c) => [c.id, c]));
      return members.map((m) => {
        const cabin = m.cabinTypeId ? cabinById.get(m.cabinTypeId) : undefined;
        return {
          personId: m.personId,
          cabinTypeId: m.cabinTypeId ?? null,
          totalAmount: round2(cabin?.pricePerPerson ?? 0),
        };
      });
    }
  }
}

/** Soll-Betrag pro Tranche für eine Person: total × percent / 100, gerundet. */
export function trancheShare(totalForPerson: number, tranchePercent: number): number {
  return round2((totalForPerson * tranchePercent) / 100);
}

/** Validiert Kojen-Kapazität ggü. tatsächlicher Belegung. Wirft bei Verletzung. */
export function validateCabinCapacity(
  cabins: PrepaymentCabin[],
  members: PrepaymentMember[],
): { ok: true } | { ok: false; cabinId: string; assigned: number; capacity: number } {
  for (const cabin of cabins) {
    const assigned = members.filter((m) => m.cabinTypeId === cabin.id).length;
    if (assigned > cabin.capacity) {
      return { ok: false, cabinId: cabin.id, assigned, capacity: cabin.capacity };
    }
  }
  return { ok: true };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Verteilt `total` gewichtet auf N Positionen, sodass die Summe der (auf Cent
 * gerundeten) Anteile EXAKT `total` ergibt (Hamilton / Largest-Remainder).
 * In Cent gerechnet: erst abrunden, dann die übrigen Cents an die größten
 * Nachkomma-Reste vergeben. Verhindert die Cent-Drift der Pro-Position-Rundung.
 */
function allocateByWeights(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalCents = Math.round(total * 100);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  // Kein sinnvolles Gewicht → gleichmäßig verteilen.
  const raw =
    weightSum > 0
      ? weights.map((w) => (totalCents * w) / weightSum)
      : weights.map(() => totalCents / n);
  const cents = raw.map((r) => Math.floor(r));
  const remainder = totalCents - cents.reduce((s, c) => s + c, 0);
  // Übrige Cents (0 ≤ remainder < n) an die größten Nachkomma-Reste, stabil
  // nach Index bei Gleichstand → deterministisch.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder && k < n; k++) cents[order[k].i] += 1;
  return cents.map((c) => c / 100);
}
