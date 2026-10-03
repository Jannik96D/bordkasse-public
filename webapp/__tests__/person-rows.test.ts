import { describe, it, expect } from "vitest";
import { buildPersonRow, visiblePersonRows, isExpandable, actionableRates, type RateInput } from "@/lib/prepayments/person-rows";

const rate = (o: Partial<RateInput> & { key: string }): RateInput => ({
  label: o.key, detail: "", soll: 0, paid: 0, pending: 0, overdue: false, ...o,
});

describe("buildPersonRow", () => {
  it("fasst Raten zusammen (Soll, bezahlt, offen) und bleibt bei Teilzahlung „underpaid“", () => {
    const r = buildPersonRow({
      key: "a", name: "Anna", allowWhilePending: true,
      rates: [rate({ key: "r1", soll: 200, paid: 200 }), rate({ key: "r2", soll: 300, paid: 100 })],
    });
    expect([r.soll, r.paid, r.open, r.status]).toEqual([500, 300, 200, "underpaid"]);
    expect(r.rates.map((x) => x.status)).toEqual(["paid", "underpaid"]);
    expect(r.actionable).toBe(true);
    expect(isExpandable(r)).toBe(true);
  });

  it("alles gedeckt → bezahlt, kein Knopf", () => {
    const r = buildPersonRow({ key: "a", name: "A", allowWhilePending: true, rates: [rate({ key: "r1", soll: 100, paid: 100 })] });
    expect(r.status).toBe("paid");
    expect(r.actionable).toBe(false);
    expect(isExpandable(r)).toBe(false);
  });

  it("Überzahlung einer Rate wird nicht gegen eine offene andere verrechnet", () => {
    const r = buildPersonRow({
      key: "a", name: "A", allowWhilePending: true,
      rates: [rate({ key: "r1", soll: 200, paid: 300 }), rate({ key: "r2", soll: 300, paid: 200 })],
    });
    expect(r.status).toBe("overpaid"); // Σ wäre exakt gedeckt, bliebe unsichtbar
    expect(r.open).toBe(100);
    expect(actionableRates(r).map((x) => x.key)).toEqual(["r2"]);
  });

  it("Selbstmeldung: Skipper darf erfassen, die Crew selbst nicht doppelt melden", () => {
    const rates = [rate({ key: "r1", soll: 100, pending: 100 })];
    const mgr = buildPersonRow({ key: "a", name: "A", allowWhilePending: true, rates });
    const crew = buildPersonRow({ key: "a", name: "A", allowWhilePending: false, rates });
    expect(mgr.status).toBe("pending");
    expect(mgr.actionable).toBe(true);
    expect(crew.status).toBe("pending");
    expect(crew.actionable).toBe(false);
  });

  it("überfällig nur solange wirklich etwas offen ist", () => {
    const late = buildPersonRow({ key: "a", name: "A", allowWhilePending: true, rates: [rate({ key: "r1", soll: 100, overdue: true })] });
    const paid = buildPersonRow({ key: "a", name: "A", allowWhilePending: true, rates: [rate({ key: "r1", soll: 100, paid: 100, overdue: true })] });
    expect(late.overdue).toBe(true);
    expect(paid.overdue).toBe(false);
  });

  it("Rundungsrand: 0,004 € Rest zählt als gedeckt", () => {
    const r = buildPersonRow({ key: "a", name: "A", allowWhilePending: true, rates: [rate({ key: "r1", soll: 33.334, paid: 33.33 })] });
    expect(r.actionable).toBe(false);
    expect(r.status).toBe("paid");
  });
});

describe("visiblePersonRows", () => {
  it("blendet Personen ohne Soll/Zahlung/Meldung aus und sortiert alphabetisch", () => {
    const mk = (name: string, soll: number) => buildPersonRow({ key: name, name, allowWhilePending: true, rates: [rate({ key: "r", soll })] });
    expect(visiblePersonRows([mk("Zora", 10), mk("Ben", 0), mk("Äpfel", 5)]).map((r) => r.name)).toEqual(["Äpfel", "Zora"]);
  });
});
