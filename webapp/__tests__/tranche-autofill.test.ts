import { describe, expect, it } from "vitest";
import { computeTrancheAutofill } from "@/lib/prepayments/tranche-autofill";

// Wie die Form-eigene formatAmount: Number → deutsches Komma-Format.
const fmt = (n: number) => n.toFixed(2).replace(".", ",");
const run = (
  tranche: { label: string; amount?: number } | null,
  current: { amount: string; description: string },
  previous: { amount: string; description: string } | null,
) => computeTrancheAutofill({ tranche, current, previous, formatAmount: fmt });

const T_A = { label: "1. Anzahlung", amount: 360 };
const T_B = { label: "Endzahlung", amount: 840 };

describe("computeTrancheAutofill", () => {
  it("füllt Betrag + Beschreibung in ein leeres Formular", () => {
    const r = run(T_A, { amount: "", description: "" }, null);
    expect(r.amount).toBe("360,00");
    expect(r.description).toBe("1. Anzahlung");
    expect(r.autofill).toEqual({ amount: "360,00", description: "1. Anzahlung" });
  });

  it("aktualisiert beide Felder beim Wechsel auf eine andere Tranche", () => {
    const prev = { amount: "360,00", description: "1. Anzahlung" };
    const r = run(T_B, { amount: "360,00", description: "1. Anzahlung" }, prev);
    expect(r.amount).toBe("840,00");
    expect(r.description).toBe("Endzahlung");
    expect(r.autofill).toEqual({ amount: "840,00", description: "Endzahlung" });
  });

  it("lässt einen manuell geänderten Betrag in Ruhe, aktualisiert aber die Auto-Beschreibung", () => {
    const prev = { amount: "360,00", description: "1. Anzahlung" };
    // User hat den Betrag manuell auf 500 gesetzt, Beschreibung unverändert.
    const r = run(T_B, { amount: "500", description: "1. Anzahlung" }, prev);
    expect(r.amount).toBe("500"); // manuell → bleibt
    expect(r.description).toBe("Endzahlung"); // noch Auto → aktualisiert
  });

  it("überschreibt im Edit-Modus (kein vorheriger Auto-Fill) keine bestehenden Werte", () => {
    // previous=null ⇒ vorbefüllte Buchungswerte gelten als „manuell".
    const r = run(T_B, { amount: "200,00", description: "Sprit Jachthafen" }, null);
    expect(r.amount).toBe("200,00");
    expect(r.description).toBe("Sprit Jachthafen");
  });

  it('leert beim Zurücksetzen auf „Keine" nur die Auto-Werte', () => {
    const prev = { amount: "360,00", description: "1. Anzahlung" };
    const r = run(null, { amount: "360,00", description: "1. Anzahlung" }, prev);
    expect(r.amount).toBe("");
    expect(r.description).toBe("");
    expect(r.autofill).toBeNull();
  });

  it('behält bei „Keine" einen manuell geänderten Betrag, leert nur die Auto-Beschreibung', () => {
    const prev = { amount: "360,00", description: "1. Anzahlung" };
    const r = run(null, { amount: "500", description: "1. Anzahlung" }, prev);
    expect(r.amount).toBe("500");
    expect(r.description).toBe("");
  });

  it("setzt nur die Beschreibung, wenn die Tranche keinen Betrag trägt", () => {
    const r = run({ label: "Restzahlung" }, { amount: "", description: "" }, null);
    expect(r.amount).toBe(""); // kein Betrag ableitbar
    expect(r.description).toBe("Restzahlung");
    expect(r.autofill).toEqual({ amount: "", description: "Restzahlung" });
  });
});
