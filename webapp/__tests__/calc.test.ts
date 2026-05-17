/**
 * Vitest-Suite für die Berechnungslogik.
 *
 * Deckt Test-Szenarien S1–S7 aus docs/calculation-rules.md ab.
 * Wird auch als "Property-Test" verwendet, um TS-Mirror und SQL-View
 * konsistent zu halten — wenn ein S-Szenario hier passt, sollte das
 * gleiche Setup gegen die DB ebenfalls passen (siehe supabase/_smoke_tests.sql).
 */

import { describe, expect, it } from "vitest";
import {
  calculateShares,
  computeBalances,
  simplifyDebts,
  type Member,
  type Transaction,
} from "@/lib/calc";

// ── Test-Crew (10 Personen, 11-Tage-Törn 5.–15. April) ──────────────────
const baseMember = (
  id: string,
  name: string,
  alc: boolean,
  fromDay = "2026-04-05",
  toDay = "2026-04-15",
): Member => ({
  personId: id,
  displayName: name,
  isAlcoholic: alc,
  effectiveFrom: fromDay,
  effectiveTo: toDay,
  days: dayDiff(fromDay, toDay),
});

function dayDiff(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

const crew: Member[] = [
  baseMember("p1", "Anna", false),
  baseMember("p2", "Ben", false),
  baseMember("p3", "Carla", true),
  baseMember("p4", "Diana", true),
  baseMember("p5", "Erik", true),
  baseMember("p6", "Finn", false, "2026-04-10", "2026-04-15"), // 6 Tage
  baseMember("p7", "Greta", false),
  baseMember("p8", "Henri", false),
  baseMember("p9", "Iris", false),
  baseMember("p10", "Jonas", false),
];

const sharesByPerson = (tx: Transaction) =>
  Object.fromEntries(
    calculateShares(tx, crew).map((s) => [s.personId, round2(s.share)]),
  );

const round2 = (n: number) => Math.round(n * 100) / 100;

// ────────────────────────────────────────────────────────────────────────
// S1: Gleichmäßig
// ────────────────────────────────────────────────────────────────────────
describe("S1: Gleichmäßig", () => {
  it("verteilt 100€ auf 10 Crew → je 10€", () => {
    const tx: Transaction = {
      id: "s1",
      type: "expense",
      date: "2026-04-06",
      amount: 100,
      alcoholAmount: 0,
      paidBy: "p1",
      splitType: "equal",
    };
    const shares = sharesByPerson(tx);
    for (const m of crew) {
      expect(shares[m.personId]).toBe(10);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// S2: An Bord (ohne Finn)
// ────────────────────────────────────────────────────────────────────────
describe("S2: An Bord", () => {
  it("80€ am 08.04. → 9 Anwesende je 8.89€, Finn 0", () => {
    const tx: Transaction = {
      id: "s2",
      type: "expense",
      date: "2026-04-08",
      amount: 80,
      alcoholAmount: 0,
      paidBy: "p1",
      splitType: "on_board",
    };
    const shares = sharesByPerson(tx);
    expect(shares["p6"]).toBeUndefined(); // Finn nicht da
    expect(round2(80 / 9)).toBe(8.89);
    for (const m of crew.filter((m) => m.personId !== "p6")) {
      expect(shares[m.personId]).toBe(8.89);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// S3: An Bord + Alkohol
// ────────────────────────────────────────────────────────────────────────
describe("S3: An Bord + Alkohol", () => {
  it("100€/30€ am 12.04., 10 da, 3 Trinker → Trinker 17, andere 7", () => {
    const tx: Transaction = {
      id: "s3",
      type: "expense",
      date: "2026-04-12",
      amount: 100,
      alcoholAmount: 30,
      paidBy: "p1",
      splitType: "on_board",
    };
    const shares = sharesByPerson(tx);
    const drinkers = ["p3", "p4", "p5"];
    for (const id of drinkers) expect(shares[id]).toBe(17);
    for (const m of crew) {
      if (!drinkers.includes(m.personId)) {
        expect(shares[m.personId]).toBe(7);
      }
    }
    // Summe-Check
    const total = Object.values(shares).reduce((a, b) => a + b, 0);
    expect(round2(total)).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S4: Zeitanteilig
// ────────────────────────────────────────────────────────────────────────
describe("S4: Zeitanteilig", () => {
  it("210€ Sprit, 9×11 + 1×6 = 105 Personentage → 22 / 12", () => {
    const tx: Transaction = {
      id: "s4",
      type: "expense",
      date: "2026-04-08",
      amount: 210,
      alcoholAmount: 0,
      paidBy: "p1",
      splitType: "time_proportional",
    };
    const shares = sharesByPerson(tx);
    expect(shares["p6"]).toBe(12); // Finn, 6 Tage
    for (const m of crew.filter((m) => m.personId !== "p6")) {
      expect(shares[m.personId]).toBe(22);
    }
    const total = Object.values(shares).reduce((a, b) => a + b, 0);
    expect(round2(total)).toBe(210);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S4b: Zeitanteilig + Alkohol
// ────────────────────────────────────────────────────────────────────────
describe("S4b: Zeitanteilig + Alkohol", () => {
  it("200€/60€ Alkohol, 9×11 + 1×6 Tage, 3 Trinker à 11 Tage", () => {
    const tx: Transaction = {
      id: "s4b",
      type: "expense",
      date: "2026-04-08",
      amount: 200,
      alcoholAmount: 60,
      paidBy: "p1",
      splitType: "time_proportional",
    };
    const shares = sharesByPerson(tx);
    // Base 140€ auf 105 Personentage → Full 14.67€, Finn 8€
    // Alkohol 60€ auf 33 Trinker-Tage → jeder Trinker 20€
    const drinkers = ["p3", "p4", "p5"];
    for (const id of drinkers) expect(shares[id]).toBe(34.67); // 14.67 + 20
    expect(shares["p6"]).toBe(8); // Finn, 6 Tage, kein Trinker
    for (const m of crew.filter(
      (m) => m.personId !== "p6" && !drinkers.includes(m.personId),
    )) {
      expect(shares[m.personId]).toBe(14.67);
    }
    // Saldo-Invariante: Summe der unrounded Shares ≈ 200
    const rawTotal = calculateShares(tx, crew).reduce((a, s) => a + s.share, 0);
    expect(Math.abs(rawTotal - 200)).toBeLessThan(0.01);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S5: Individuell
// ────────────────────────────────────────────────────────────────────────
describe("S5: Individuell", () => {
  it("120€ Schwimmwesten für 3 Markierte → je 40, andere 0", () => {
    const tx: Transaction = {
      id: "s5",
      type: "expense",
      date: "2026-04-08",
      amount: 120,
      alcoholAmount: 0,
      paidBy: "p1",
      splitType: "individual",
      participants: ["p2", "p3", "p4"],
    };
    const shares = sharesByPerson(tx);
    expect(shares["p2"]).toBe(40);
    expect(shares["p3"]).toBe(40);
    expect(shares["p4"]).toBe(40);
    expect(shares["p1"]).toBeUndefined();
    expect(shares["p10"]).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// S6: Gutschrift "An Alle" (mit Vorgeschichte Yacht-Zeitanteilig)
// ────────────────────────────────────────────────────────────────────────
describe("S6: Gutschrift An Alle", () => {
  it("Yacht 2400€ zeitanteilig + Ben →Alle 240€", () => {
    const txs: Transaction[] = [
      {
        id: "yacht",
        type: "expense",
        date: "2026-04-05",
        amount: 2400,
        alcoholAmount: 0,
        paidBy: "p1",
        splitType: "time_proportional",
      },
      {
        id: "credit-alle",
        type: "credit",
        date: "2026-04-05",
        amount: 240,
        alcoholAmount: 0,
        creditFrom: "p2", // Ben
        creditTo: null,    // "Alle"
      },
    ];

    const balances = computeBalances(txs, crew);
    const byId = Object.fromEntries(balances.map((b) => [b.personId, b]));

    // Salden gemäß docs/calculation-rules.md §S6
    expect(round2(byId["p1"].balance)).toBe(2121.9);   // Anna 2121.90
    expect(round2(byId["p2"].balance)).toBe(-11.43);   // Ben
    expect(round2(byId["p6"].balance)).toBe(-163.81);  // Finn
    expect(round2(byId["p7"].balance)).toBe(-278.10);  // andere

    // Saldo-Invariante: Summe ≈ 0
    const total = balances.reduce((a, b) => a + b.balance, 0);
    expect(Math.abs(total)).toBeLessThan(0.01);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S7: Schulden-Greedy
// ────────────────────────────────────────────────────────────────────────
describe("S7: Schulden-Greedy", () => {
  it("300€ Anna (gleichmäßig) + 150€ Erik (an_bord, alle 10 da) → 9 Überweisungen", () => {
    // S7 setzt voraus, dass alle 10 da sind. Wir bauen die Crew dafür neu.
    const fullCrew: Member[] = crew.map((m) =>
      m.personId === "p6" ? { ...m, effectiveFrom: "2026-04-05", days: 11 } : m,
    );

    const txs: Transaction[] = [
      {
        id: "s7-1",
        type: "expense",
        date: "2026-04-06",
        amount: 300,
        alcoholAmount: 0,
        paidBy: "p1", // Anna
        splitType: "equal",
      },
      {
        id: "s7-2",
        type: "expense",
        date: "2026-04-07",
        amount: 150,
        alcoholAmount: 0,
        paidBy: "p5", // Erik
        splitType: "on_board",
      },
    ];

    const balances = computeBalances(txs, fullCrew);
    const byId = Object.fromEntries(balances.map((b) => [b.personId, round2(b.balance)]));

    expect(byId["p1"]).toBe(255);
    expect(byId["p5"]).toBe(105);
    for (const id of ["p2", "p3", "p4", "p6", "p7", "p8", "p9", "p10"]) {
      expect(byId[id]).toBe(-45);
    }

    const debts = simplifyDebts(balances);
    expect(debts.length).toBe(9);

    // Sanity-Check: Summe der Beträge muss Summe der absoluten Salden
    // (nur positive Seite) entsprechen = 360
    const totalTransferred = debts.reduce((a, d) => a + d.amount, 0);
    expect(round2(totalTransferred)).toBe(360);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S8: Pro Person (individuelle Beträge pro Person)
// ────────────────────────────────────────────────────────────────────────
describe("S8: Pro Person", () => {
  it("56,30€ Restaurant mit gemischten Beträgen", () => {
    const tx: Transaction = {
      id: "s8",
      type: "expense",
      date: "2026-04-08",
      amount: 56.3,
      alcoholAmount: 0,
      paidBy: "p1",
      splitType: "per_person",
      participantAmounts: [
        { personId: "p1", amount: 12.5 }, // Anna (Jannik)
        { personId: "p2", amount: 14.5 }, // Ben
        { personId: "p3", amount: 20 }, // Carla (= 3 + 17 vom Mini-Rechner)
        { personId: "p7", amount: 9.3 }, // Greta
      ],
    };
    const shares = calculateShares(tx, crew);
    const byId = Object.fromEntries(shares.map((s) => [s.personId, round2(s.share)]));
    expect(byId["p1"]).toBe(12.5);
    expect(byId["p2"]).toBe(14.5);
    expect(byId["p3"]).toBe(20);
    expect(byId["p7"]).toBe(9.3);
    // Andere haben keinen Anteil
    expect(byId["p4"]).toBeUndefined();
    expect(byId["p6"]).toBeUndefined();
    // Summe = amount
    const rawTotal = shares.reduce((a, s) => a + s.share, 0);
    expect(round2(rawTotal)).toBe(56.3);
  });

  it("Pro Person mit Trinkgeld verteilt proportional", () => {
    // 60€ Rechnung: Anna 20, Ben 30, Carla 10 — Trinkgeld 6€ (10%)
    // → Anna 22, Ben 33, Carla 11, Σ = 66
    const tx: Transaction = {
      id: "s8-tip",
      type: "expense",
      date: "2026-04-08",
      amount: 60,
      alcoholAmount: 0,
      tipAmount: 6,
      paidBy: "p1",
      splitType: "per_person",
      participantAmounts: [
        { personId: "p1", amount: 20 },
        { personId: "p2", amount: 30 },
        { personId: "p3", amount: 10 },
      ],
    };
    const shares = calculateShares(tx, crew);
    const byId = Object.fromEntries(shares.map((s) => [s.personId, round2(s.share)]));
    expect(byId["p1"]).toBe(22);
    expect(byId["p2"]).toBe(33);
    expect(byId["p3"]).toBe(11);
    const rawTotal = shares.reduce((a, s) => a + s.share, 0);
    expect(Math.abs(rawTotal - 66)).toBeLessThan(0.01);
  });

  it("Trinkgeld landet auf JEDEM Beteiligten, niemals auf Nicht-Beteiligten", () => {
    // Restaurant-Szenario: Crew 5 essen mit, 5 nicht. Trinkgeld 18€.
    // Jeder Beteiligte muss einen Anteil > eigenem Bestellbetrag bekommen
    // (= Bestellung + sein Trinkgeld-Anteil). Nicht-Beteiligte: kein Anteil.
    const tx: Transaction = {
      id: "tip-distribution",
      type: "expense",
      date: "2026-04-08",
      amount: 90,
      alcoholAmount: 0,
      tipAmount: 18, // 20%
      paidBy: "p1",
      splitType: "per_person",
      participantAmounts: [
        { personId: "p1", amount: 15 },
        { personId: "p2", amount: 25 },
        { personId: "p3", amount: 30 },
        { personId: "p4", amount: 12 },
        { personId: "p7", amount: 8 },
      ],
    };
    const shares = calculateShares(tx, crew);
    const byId = Object.fromEntries(shares.map((s) => [s.personId, s.share]));

    // Beteiligte: jeder bekommt eigenen Betrag × 1,2 (Trinkgeld-Faktor 18/90).
    const factor = 1.2;
    expect(round2(byId["p1"])).toBe(round2(15 * factor)); // 18
    expect(round2(byId["p2"])).toBe(round2(25 * factor)); // 30
    expect(round2(byId["p3"])).toBe(round2(30 * factor)); // 36
    expect(round2(byId["p4"])).toBe(round2(12 * factor)); // 14.40
    expect(round2(byId["p7"])).toBe(round2(8 * factor));  // 9.60

    // Nicht-Beteiligte: explizit kein Eintrag (calculateShares filtert share=0).
    for (const id of ["p5", "p6", "p8", "p9", "p10"]) {
      expect(byId[id]).toBeUndefined();
    }

    // Σ aller Anteile = amount + tip_amount
    const rawTotal = shares.reduce((a, s) => a + s.share, 0);
    expect(Math.abs(rawTotal - 108)).toBeLessThan(0.01);

    // Bilanz: Anna (paid_by) hat 108€ ausgelegt, eigener Anteil 18€,
    // also Saldo +90. Niemand hat von außen reingebucht, also Σ = 0.
    const balances = computeBalances([tx], crew);
    const anna = balances.find((b) => b.personId === "p1")!;
    expect(round2(anna.paid)).toBe(108); // 90 + 18 Trinkgeld
    expect(round2(anna.balance)).toBe(90); // 108 - 18 eigener Anteil
    const sumBalances = balances.reduce((a, b) => a + b.balance, 0);
    expect(Math.abs(sumBalances)).toBeLessThan(0.01);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Edge-Cases
// ────────────────────────────────────────────────────────────────────────
describe("Edge-Cases", () => {
  it("Alkohol-Anteil bei null Trinkern → auf alle Active verteilen", () => {
    const noDrinkerCrew = crew.map((m) => ({ ...m, isAlcoholic: false }));
    const tx: Transaction = {
      id: "edge1",
      type: "expense",
      date: "2026-04-12",
      amount: 100,
      alcoholAmount: 30,
      paidBy: "p1",
      splitType: "equal",
    };
    const shares = Object.fromEntries(
      calculateShares(tx, noDrinkerCrew).map((s) => [s.personId, round2(s.share)]),
    );
    // Alle bekommen vollen Anteil = 100/10 = 10
    for (const m of noDrinkerCrew) {
      expect(shares[m.personId]).toBe(10);
    }
  });

  it("Saldo-Summe bleibt 0 auch bei Mix aus Ausgaben + Gutschriften", () => {
    const txs: Transaction[] = [
      { id: "a", type: "expense", date: "2026-04-08", amount: 100, alcoholAmount: 0, paidBy: "p1", splitType: "equal" },
      { id: "b", type: "credit",  date: "2026-04-08", amount: 50,  alcoholAmount: 0, creditFrom: "p2", creditTo: "p3" },
      { id: "c", type: "credit",  date: "2026-04-08", amount: 90,  alcoholAmount: 0, creditFrom: "p4", creditTo: null },
    ];
    const balances = computeBalances(txs, crew);
    const total = balances.reduce((a, b) => a + b.balance, 0);
    expect(Math.abs(total)).toBeLessThan(0.01);
  });
});
