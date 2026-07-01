/**
 * Tests für das Fremdwährungs-Modul (Migration 0041):
 *  - Umrechnung Fremd → EUR (Rundung)
 *  - kuratierte Währungsliste (alle vom Anbieter abgedeckt)
 *  - Live-Kurs-Abruf (open.er-api.com, invertiert zu EUR-pro-Einheit)
 *  - Schema akzeptiert/validiert die Währungsfelder korrekt
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// `server-only` ist ein RSC-Marker ohne Node-Auflösung → im Test neutralisieren,
// damit get-rate.ts (server-seitiger Kurs-Abruf) importierbar bleibt.
vi.mock("server-only", () => ({}));

import { foreignToEur } from "@/lib/rates/convert";
import {
  FOREIGN_CURRENCY_CODES,
  isSupportedCurrency,
  currencyLabel,
} from "@/lib/rates/currencies";
import { getLiveRates } from "@/lib/rates/get-rate";
import { resolveExpenseCurrency, resolveCreditCurrency } from "@/lib/rates/resolve";
import { ExpenseSchema, CreditSchema } from "@/lib/validation/transaction-schema";

const baseExpense = {
  trip_id: crypto.randomUUID(),
  date: "2026-07-01",
  description: "Restaurant",
  category_id: null,
  paid_by: crypto.randomUUID(),
  split_type: "equal" as const,
  participant_ids: [],
};

describe("foreignToEur", () => {
  it("rechnet Fremdbetrag mit Kurs auf Cent gerundet um", () => {
    expect(foreignToEur(500, 0.0903)).toBe(45.15);
  });
  it("rundet korrekt auf 2 Nachkommastellen", () => {
    expect(foreignToEur(500, 0.09032)).toBe(45.16);
  });
  it("EUR-Kopplung XPF (1 € = 119,3317 XPF → Kurs ~0,008380)", () => {
    expect(foreignToEur(1000, 1 / 119.3317)).toBeCloseTo(8.38, 2);
  });
});

describe("Währungsliste (kuratiert)", () => {
  it("enthält alle 21 Törn-Währungen inkl. Exoten", () => {
    expect(FOREIGN_CURRENCY_CODES).toHaveLength(21);
    for (const code of ["DKK", "SEK", "BGN", "ISK", "TRY", "ALL", "CAD", "MXN", "THB", "XCD", "BBD", "BSD", "DOP", "MUR", "SCR", "XPF"]) {
      expect(FOREIGN_CURRENCY_CODES).toContain(code);
    }
  });
  it("EUR ist keine Fremdwährung", () => {
    expect(isSupportedCurrency("EUR")).toBe(false);
    expect(isSupportedCurrency("SEK")).toBe(true);
    expect(isSupportedCurrency("XXX")).toBe(false);
  });
  it("liefert deutsches Label mit Fallback auf den Code", () => {
    expect(currencyLabel("SEK")).toBe("Schwedische Krone");
    expect(currencyLabel("XXX")).toBe("XXX");
  });
});

describe("getLiveRates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invertiert EUR-Basiskurse zu EUR-pro-Einheit und filtert Unbekanntes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: "success", rates: { SEK: 11.08, XPF: 119.33 } }),
      }),
    );
    const rates = await getLiveRates(["SEK", "XPF", "ZZZ"]);
    expect(rates.SEK).toBeCloseTo(1 / 11.08, 6);
    expect(rates.XPF).toBeCloseTo(1 / 119.33, 6);
    expect(rates.ZZZ).toBeUndefined();
  });

  it("liefert {} bei fehlgeschlagenem Abruf (Offline-Fallback greift dann anderswo)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await getLiveRates(["SEK"])).toEqual({});
  });

  it("liefert {} ohne angefragte Währungen", async () => {
    expect(await getLiveRates([])).toEqual({});
  });
});

describe("ExpenseSchema – Fremdwährung", () => {
  it("akzeptiert Fremdwährungs-Buchung und bewahrt die Kurs-Präzision", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "500",
      original_currency: "SEK",
      exchange_rate: "0,0903",
      rate_source: "live",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.original_currency).toBe("SEK");
      // NICHT auf 2 Nachkommastellen gerundet — kleine Kurse blieben sonst 0,09.
      expect(r.data.exchange_rate).toBe(0.0903);
      expect(r.data.rate_source).toBe("live");
    }
  });

  it("normalisiert EUR/leer zu null (keine Fremdwährung)", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "20", original_currency: "EUR" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.original_currency).toBeNull();
      expect(r.data.exchange_rate).toBeNull();
    }
  });

  it("lehnt Fremdwährung ohne gültigen Kurs ab", () => {
    const r = ExpenseSchema.safeParse({ ...baseExpense, amount: "500", original_currency: "SEK" });
    expect(r.success).toBe(false);
  });

  it("lehnt nicht unterstützte Währung ab", () => {
    const r = ExpenseSchema.safeParse({
      ...baseExpense,
      amount: "500",
      original_currency: "XXX",
      exchange_rate: "0,5",
    });
    expect(r.success).toBe(false);
  });
});

describe("resolveExpenseCurrency", () => {
  const base = {
    split_type: "equal",
    alcohol_amount: 0,
    tip_amount: 0,
    rate_source: "live" as string | null,
    bank_eur_amount: null as number | null,
    participant_amounts: [] as { person_id: string; amount: number }[],
  };

  it("EUR-Buchung: Betrag unverändert, Herkunft null", () => {
    const r = resolveExpenseCurrency({ ...base, amount: 20, original_currency: null, exchange_rate: null });
    expect(r.amount).toBe(20);
    expect(r.original_currency).toBeNull();
    expect(r.exchange_rate).toBeNull();
    expect(r.rate_source).toBeNull();
  });

  it("Fremdwährung: Fremdbetrag → EUR, Herkunft gesetzt", () => {
    const r = resolveExpenseCurrency({ ...base, amount: 500, original_currency: "SEK", exchange_rate: 0.0903 });
    expect(r.amount).toBe(45.15);
    expect(r.original_amount).toBe(500);
    expect(r.original_currency).toBe("SEK");
    expect(r.rate_source).toBe("live");
  });

  it("Bankbetrag überschreibt Kurs → rate_source='bank', effektiver Kurs", () => {
    const r = resolveExpenseCurrency({
      ...base, amount: 500, original_currency: "SEK", exchange_rate: 0.0903, bank_eur_amount: 45.8,
    });
    expect(r.rate_source).toBe("bank");
    expect(r.exchange_rate).toBeCloseTo(45.8 / 500, 6);
    expect(r.amount).toBe(45.8);
  });

  it("Pro Person Fremdwährung: je Person Fremd→EUR, Summe als Betrag", () => {
    const r = resolveExpenseCurrency({
      ...base,
      split_type: "per_person",
      amount: 0,
      original_currency: "SEK",
      exchange_rate: 0.1,
      participant_amounts: [{ person_id: "a", amount: 100 }, { person_id: "b", amount: 150 }],
    });
    expect(r.amount).toBe(25);
    expect(r.original_amount).toBe(250);
    expect(r.perPerson).toEqual([
      { person_id: "a", amount: 10, original_amount: 100 },
      { person_id: "b", amount: 15, original_amount: 150 },
    ]);
  });

  it("Pro Person + Bankbetrag: effektiver Kurs auf alle Anteile", () => {
    const r = resolveExpenseCurrency({
      ...base,
      split_type: "per_person",
      amount: 0,
      original_currency: "SEK",
      exchange_rate: 0.09,
      bank_eur_amount: 25,
      participant_amounts: [{ person_id: "a", amount: 100 }, { person_id: "b", amount: 150 }],
    });
    expect(r.rate_source).toBe("bank");
    expect(r.amount).toBe(25);
    expect(r.perPerson.map((p) => p.amount)).toEqual([10, 15]);
  });
});

describe("resolveCreditCurrency", () => {
  it("Fremdwährung + Bankbetrag → bank-Kurs", () => {
    const r = resolveCreditCurrency({
      amount: 1000, original_currency: "DKK", exchange_rate: 0.134, rate_source: "manual", bank_eur_amount: 130,
    });
    expect(r.rate_source).toBe("bank");
    expect(r.exchange_rate).toBeCloseTo(0.13, 6);
    expect(r.amount).toBe(130);
  });
});

describe("CreditSchema – Fremdwährung", () => {
  it("akzeptiert Fremdwährungs-Gutschrift", () => {
    const r = CreditSchema.safeParse({
      trip_id: crypto.randomUUID(),
      date: "2026-07-01",
      description: "",
      amount: "1000",
      credit_from: crypto.randomUUID(),
      credit_to: crypto.randomUUID(),
      original_currency: "DKK",
      exchange_rate: "0,134",
      rate_source: "manual",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.exchange_rate).toBe(0.134);
  });
});
