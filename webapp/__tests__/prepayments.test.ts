/**
 * Vitest-Suite für die Anzahlungs-Soll-Berechnung.
 * Spec-Test-Szenario aus docs/prepayments.md §Test-Szenario.
 */

import { describe, expect, it } from "vitest";
import {
  calculateObligations,
  trancheShare,
  validateCabinCapacity,
  type PrepaymentCabin,
  type PrepaymentMember,
} from "@/lib/calc/prepayment-shares";

describe("calculateObligations — gleichmaessig", () => {
  it("teilt den Gesamtbetrag gleich auf alle", () => {
    const members: PrepaymentMember[] = [
      { personId: "a", days: 7 },
      { personId: "b", days: 7 },
      { personId: "c", days: 7 },
      { personId: "d", days: 7 },
    ];
    const out = calculateObligations("gleichmaessig", 1000, members);
    expect(out.every((o) => o.totalAmount === 250)).toBe(true);
  });

  it("verteilt Rest-Cents so, dass die Summe EXAKT dem Plan entspricht (Fund C-3)", () => {
    const members: PrepaymentMember[] = [
      { personId: "a", days: 7 },
      { personId: "b", days: 7 },
      { personId: "c", days: 7 },
    ];
    const out = calculateObligations("gleichmaessig", 1000, members);
    const sum = out.reduce((s, o) => s + o.totalAmount, 0);
    expect(Math.round(sum * 100) / 100).toBe(1000); // vor Fix: 999,99
    // Zwei zahlen 333,33, einer bekommt den Rest-Cent (333,34).
    expect(out.filter((o) => o.totalAmount === 333.34)).toHaveLength(1);
    expect(out.filter((o) => o.totalAmount === 333.33)).toHaveLength(2);
  });
});

describe("calculateObligations — zeitanteilig", () => {
  it("teilt nach Bord-Tagen", () => {
    const members: PrepaymentMember[] = [
      { personId: "a", days: 10 }, // 10 / 30
      { personId: "b", days: 10 },
      { personId: "c", days: 10 },
    ];
    const out = calculateObligations("zeitanteilig", 900, members);
    expect(out.find((o) => o.personId === "a")?.totalAmount).toBe(300);
  });

  it("verteilt zeitanteilige Rest-Cents exakt auf den Plan (Fund C-3)", () => {
    const members: PrepaymentMember[] = [
      { personId: "a", days: 3 },
      { personId: "b", days: 3 },
      { personId: "c", days: 1 },
    ];
    const out = calculateObligations("zeitanteilig", 100, members);
    const sum = out.reduce((s, o) => s + o.totalAmount, 0);
    expect(Math.round(sum * 100) / 100).toBe(100); // vor Fix: 100,01
  });

  it("Fallback auf gleichmäßig wenn niemand Tage hat", () => {
    const members: PrepaymentMember[] = [
      { personId: "a", days: 0 },
      { personId: "b", days: 0 },
    ];
    const out = calculateObligations("zeitanteilig", 100, members);
    expect(out.every((o) => o.totalAmount === 50)).toBe(true);
  });
});

describe("calculateObligations — kojen", () => {
  it("Spec-Szenario: Anna Einzel, Ben+Clara Doppel, David+Eva Stock", () => {
    const cabins: PrepaymentCabin[] = [
      { id: "einzel", pricePerPerson: 1000, capacity: 1 },
      { id: "doppel", pricePerPerson: 800, capacity: 2 },
      { id: "stock", pricePerPerson: 500, capacity: 2 },
    ];
    const members: PrepaymentMember[] = [
      { personId: "anna", days: 7, cabinTypeId: "einzel" },
      { personId: "ben", days: 7, cabinTypeId: "doppel" },
      { personId: "clara", days: 7, cabinTypeId: "doppel" },
      { personId: "david", days: 7, cabinTypeId: "stock" },
      { personId: "eva", days: 7, cabinTypeId: "stock" },
    ];
    const out = calculateObligations("kojen", 3700, members, cabins);
    const byId = Object.fromEntries(out.map((o) => [o.personId, o.totalAmount]));
    expect(byId.anna).toBe(1000);
    expect(byId.ben).toBe(800);
    expect(byId.clara).toBe(800);
    expect(byId.david).toBe(500);
    expect(byId.eva).toBe(500);
    expect(out.reduce((s, o) => s + o.totalAmount, 0)).toBe(3600);
    // Hinweis: total_amount (3700) != Summe Kojen — Restausgleich (100€) läuft
    // laut Spec automatisch über die Bordkasse-Bilanz.
  });

  it("ohne Kojen-Zuordnung: Soll = 0", () => {
    const cabins: PrepaymentCabin[] = [
      { id: "einzel", pricePerPerson: 1000, capacity: 1 },
    ];
    const out = calculateObligations(
      "kojen",
      1000,
      [{ personId: "a", days: 0, cabinTypeId: null }],
      cabins,
    );
    expect(out[0].totalAmount).toBe(0);
  });
});

describe("trancheShare", () => {
  it("rechnet Prozent korrekt", () => {
    expect(trancheShare(1000, 30)).toBe(300);
    expect(trancheShare(1000, 70)).toBe(700);
    // Rundung: 800 × 30% = 240
    expect(trancheShare(800, 30)).toBe(240);
    // Spec-Szenario Anna 30% = 300, 70% = 700
    expect(trancheShare(1000, 30)).toBe(300);
    expect(trancheShare(1000, 70)).toBe(700);
  });
});

describe("validateCabinCapacity", () => {
  it("akzeptiert valide Belegung", () => {
    const cabins: PrepaymentCabin[] = [
      { id: "doppel", pricePerPerson: 800, capacity: 2 },
    ];
    const members: PrepaymentMember[] = [
      { personId: "a", days: 0, cabinTypeId: "doppel" },
      { personId: "b", days: 0, cabinTypeId: "doppel" },
    ];
    expect(validateCabinCapacity(cabins, members).ok).toBe(true);
  });

  it("erkennt Überbelegung", () => {
    const cabins: PrepaymentCabin[] = [
      { id: "einzel", pricePerPerson: 1000, capacity: 1 },
    ];
    const members: PrepaymentMember[] = [
      { personId: "a", days: 0, cabinTypeId: "einzel" },
      { personId: "b", days: 0, cabinTypeId: "einzel" },
    ];
    const res = validateCabinCapacity(cabins, members);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.assigned).toBe(2);
      expect(res.capacity).toBe(1);
    }
  });
});
