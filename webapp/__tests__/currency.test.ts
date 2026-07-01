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
