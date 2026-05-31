/**
 * Berechnet Soll-Beträge pro Person für den Anzahlungs-Plan eines Trips.
 *
 * Vier Aufteilungsmethoden:
 *   - gleichmaessig:  total_amount gleichmäßig auf alle Crew
 *   - zeitanteilig:   nach Bord-Tagen
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
      const share = round2(totalAmount / members.length);
      return members.map((m) => ({ personId: m.personId, totalAmount: share }));
    }
    case "zeitanteilig": {
      const totalDays = members.reduce((s, m) => s + Math.max(0, m.days), 0);
      if (totalDays === 0) {
        const share = round2(totalAmount / members.length);
        return members.map((m) => ({ personId: m.personId, totalAmount: share }));
      }
      return members.map((m) => ({
        personId: m.personId,
        totalAmount: round2((totalAmount * Math.max(0, m.days)) / totalDays),
      }));
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
