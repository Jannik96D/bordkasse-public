// Reine Berechnungen der Reise-Posten (lib/calc/prepayment-item-shares.ts).
import { describe, expect, it } from "vitest";
import {
  allocateItemProviderShares,
  calculateItemObligations,
  isItemComplete,
  itemCellStatus,
} from "@/lib/calc/prepayment-item-shares";
import { allocateByWeights } from "@/lib/calc/prepayment-shares";

const cents = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100);

describe("allocateByWeights (exportiert)", () => {
  it("Σ = total exakt, auch bei 100 / 3", () => {
    expect(cents(allocateByWeights(100, [1, 1, 1]))).toBe(10000);
    expect(allocateByWeights(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
  });
});

describe("calculateItemObligations", () => {
  const m = (id: string, days = 0, manualAmount?: number) => ({ personId: id, days, manualAmount });

  it("gleichmäßig: Largest-Remainder, Σ = Summe exakt", () => {
    const r = calculateItemObligations("gleichmaessig", 1000, [m("a"), m("b"), m("c")]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(cents(r.shares.map((s) => s.amount))).toBe(100000);
      expect(r.shares.map((s) => s.amount)).toEqual([333.34, 333.33, 333.33]);
    }
  });

  it("zeitanteilig: nach Bordtagen, Σ = Summe exakt", () => {
    const r = calculateItemObligations("zeitanteilig", 210, [m("a", 11), m("b", 11), m("c", 6)]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(cents(r.shares.map((s) => s.amount))).toBe(21000);
      expect(r.shares[2].amount).toBeLessThan(r.shares[0].amount);
    }
  });

  it("individuell: Pass-through, wenn Σ = Summe", () => {
    const r = calculateItemObligations("individuell", 300, [m("a", 0, 50), m("b", 0, 100), m("c", 0, 150)]);
    expect(r).toEqual({
      ok: true,
      shares: [
        { personId: "a", amount: 50 },
        { personId: "b", amount: 100 },
        { personId: "c", amount: 150 },
      ],
    });
  });

  it("individuell: Σ ≠ Summe → Fehler (auch 1 Cent)", () => {
    const r = calculateItemObligations("individuell", 300, [m("a", 0, 150), m("b", 0, 149.99)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("299,99");
  });

  it("individuell: negativer Betrag → Fehler", () => {
    expect(calculateItemObligations("individuell", 100, [m("a", 0, 150), m("b", 0, -50)]).ok).toBe(false);
  });

  it("Summe 0 oder niemand eingetragen → Fehler", () => {
    expect(calculateItemObligations("gleichmaessig", 0, [m("a")]).ok).toBe(false);
    expect(calculateItemObligations("gleichmaessig", 100, []).ok).toBe(false);
  });
});

describe("allocateItemProviderShares", () => {
  const soll = [
    { personId: "a", amount: 50 },
    { personId: "b", amount: 100 },
    { personId: "c", amount: 150 },
    { personId: "d", amount: 0 }, // reist selbst an
  ];

  it("volle Zahlung = Soll je Person, ohne Anteil für d", () => {
    expect(allocateItemProviderShares(300, soll)).toEqual([
      { personId: "a", amount: 50 },
      { personId: "b", amount: 100 },
      { personId: "c", amount: 150 },
    ]);
  });

  it("Σ Anteile = Betrag exakt bei krummen Beträgen", () => {
    expect(cents(allocateItemProviderShares(100.01, soll).map((s) => s.amount))).toBe(10001);
  });

  it("kumulativ: drei Teilzahlungen bei gleichem Soll landen exakt beim Soll", () => {
    const eq = [
      { personId: "a", amount: 100 },
      { personId: "b", amount: 100 },
      { personId: "c", amount: 100 },
    ];
    const already: { personId: string; amount: number }[] = [];
    for (let i = 0; i < 3; i++) already.push(...allocateItemProviderShares(100, eq, already));
    const by = (id: string) => Math.round(already.filter((x) => x.personId === id).reduce((s, x) => s + x.amount, 0) * 100);
    expect([by("a"), by("b"), by("c")]).toEqual([10000, 10000, 10000]);
  });

  it("Fallback, wenn bisherige Anteile nicht zum Soll passen (Person ohne Soll) — Σ bleibt exakt", () => {
    const r = allocateItemProviderShares(60, soll, [{ personId: "x", amount: 10 }]);
    expect(cents(r.map((s) => s.amount))).toBe(6000);
    expect(r.some((s) => s.personId === "x")).toBe(false);
  });

  it("kein Soll oder Betrag 0 → leer", () => {
    expect(allocateItemProviderShares(100, [{ personId: "a", amount: 0 }])).toEqual([]);
    expect(allocateItemProviderShares(0, soll)).toEqual([]);
  });
});

describe("itemCellStatus / isItemComplete", () => {
  it("Statuslogik inkl. überzahlt vor 0-Soll", () => {
    expect(itemCellStatus(100, 0, 0)).toBe("open");
    expect(itemCellStatus(100, 40, 0)).toBe("underpaid");
    expect(itemCellStatus(100, 40, 60)).toBe("pending");
    expect(itemCellStatus(100, 100, 0)).toBe("paid");
    expect(itemCellStatus(100, 0, 100)).toBe("pending");
    expect(itemCellStatus(0, 20, 0)).toBe("overpaid");
    expect(itemCellStatus(0, 0, 0)).toBe("paid");
  });

  it("abgeschlossen nur, wenn Crew UND Anbieter gedeckt sind", () => {
    const cells = [{ soll: 100, paid: 100 }, { soll: 0, paid: 0 }];
    expect(isItemComplete({ totalAmount: 100, providerPaid: 100, cells })).toBe(true);
    expect(isItemComplete({ totalAmount: 100, providerPaid: 99.99, cells })).toBe(false);
    expect(isItemComplete({ totalAmount: 100, providerPaid: 100, cells: [{ soll: 100, paid: 50 }] })).toBe(false);
    // Delta 1: ohne jede Sollzeile ist ein Posten nicht abgeschlossen.
    expect(isItemComplete({ totalAmount: 100, providerPaid: 100, cells: [] })).toBe(false);
    // M4: Überzahlung ist nicht „abgeschlossen" — das Geld muss zurück.
    expect(isItemComplete({ totalAmount: 100, providerPaid: 100, cells: [{ soll: 100, paid: 120 }] })).toBe(false);
    expect(isItemComplete({ totalAmount: 100, providerPaid: 100, cells: [{ soll: 0, paid: 5 }] })).toBe(false);
  });
});
