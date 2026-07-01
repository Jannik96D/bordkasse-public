/**
 * Tests für Zod-Schemas (Validation/Currency-Parsing).
 *
 * Sichert ab, dass Beträge mit deutschem Komma ("12,50") akzeptiert werden,
 * weil HTML-Formulare auf iPhone/Android meist Komma liefern.
 */

import { describe, expect, it } from "vitest";
import { CreditSchema, ExpenseSchema } from "@/lib/validation/transaction-schema";

const TRIP_ID = crypto.randomUUID();
const PERSON_A = crypto.randomUUID();
const PERSON_B = crypto.randomUUID();

const baseExpense = {
  trip_id: TRIP_ID,
  date: "2026-04-08",
  description: "Edeka",
  category_id: null,
  paid_by: PERSON_A,
  split_type: "equal" as const,
  participant_ids: [],
};

const baseCredit = {
  trip_id: TRIP_ID,
  date: "2026-04-08",
  description: "",
  credit_from: PERSON_A,
  credit_to: PERSON_B,
};

describe("ExpenseSchema – Komma vs. Punkt", () => {
  it("akzeptiert Betrag mit deutschem Komma", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "12,50" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(12.5);
  });

  it("akzeptiert Betrag mit Punkt", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "12.50" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(12.5);
  });

  it("akzeptiert Alkohol-Anteil mit Komma", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "100",
      alcohol_amount: "30,00",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.alcohol_amount).toBe(30);
  });

  it("lehnt 0 als Betrag ab", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "0" });
    expect(r.success).toBe(false);
  });

  it("lehnt Alkohol-Anteil > Betrag ab", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "10,00",
      alcohol_amount: "20,00",
    });
    expect(r.success).toBe(false);
  });

  it("akzeptiert leeren Alkohol-Anteil als 0", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "10",
      alcohol_amount: 0,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.alcohol_amount).toBe(0);
  });
});

describe("CreditSchema – Komma vs. Punkt", () => {
  it("akzeptiert Gutschrift-Betrag mit Komma", () => {
    const r = CreditSchema.safeParse({ ...baseCredit, amount: "240,00" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(240);
  });

  it("akzeptiert credit_to = null (= Alle)", () => {
    const r = CreditSchema.safeParse({
      ...baseCredit,
      amount: "240",
      credit_to: null,
    });
    expect(r.success).toBe(true);
  });

  it("lehnt Von == An ab", () => {
    const r = CreditSchema.safeParse({
      ...baseCredit,
      amount: "100",
      credit_to: baseCredit.credit_from,
    });
    expect(r.success).toBe(false);
  });
});

describe("Beträge als Rechen-Ausdruck (Pfand/Privatkäufe rausrechnen)", () => {
  it("wertet Subtraktion im Betragsfeld aus (Bon minus Pfand)", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "47,30 - 6,00" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(41.3);
  });

  it("wertet Addition mit Komma aus", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "9,80+1,50" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(11.3);
  });

  it("wertet Klammern + Multiplikation aus", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "(2*4,50)" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(9);
  });

  it("wertet Ausdruck im Alkohol-Anteil aus", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "100",
      alcohol_amount: "10+5",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.alcohol_amount).toBe(15);
  });

  it("wertet Division im Gutschrift-Betrag aus", () => {
    const r = CreditSchema.safeParse({ ...baseCredit, amount: "240 / 4" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(60);
  });

  it("lehnt unsinnige Eingabe ab (kein stiller 0-Fallback)", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "abc" });
    expect(r.success).toBe(false);
  });

  it("lehnt negatives Ergebnis ab", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "5-10" });
    expect(r.success).toBe(false);
  });
});
