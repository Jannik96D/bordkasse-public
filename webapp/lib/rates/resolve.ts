import { round2 } from "@/lib/utils";
import { foreignToEur } from "./convert";

// ── Fremdwährung (Migration 0041) ─────────────────────────────────────────
// Bei einer Fremdwährungs-Buchung tragen die eingegebenen Beträge (amount,
// alcohol_amount, tip_amount, Pro-Person-Beträge) den FREMDBETRAG. Diese Helfer
// rechnen zum Buchungskurs in EUR um (das, womit die Bilanz rechnet) und legen
// die Herkunft ab (original_currency/original_amount/exchange_rate/rate_source).
// EUR ist die einzige Wahrheit für v_balances & Co. — daher wird die Umrechnung
// zentral serverseitig gemacht, nicht dem Client-Betrag vertraut. Pure Funktionen
// (kein "use server"), damit sie unit-testbar sind (__tests__/currency.test.ts).

export interface ExpenseCurrencyFields {
  original_currency: string | null;
  original_amount: number | null;
  exchange_rate: number | null;
  rate_source: string | null;
}
export interface ResolvedExpenseCurrency extends ExpenseCurrencyFields {
  amount: number;
  alcohol_amount: number;
  tip_amount: number;
  /** Pro-Person-Zeilen in EUR (+ Fremdbetrag als original_amount). */
  perPerson: { person_id: string; amount: number; original_amount: number | null }[];
}

/** Effektiver Kurs: der eingegebene Kurs — ODER, wenn der tatsächliche
 *  Bankbetrag nachgetragen wurde, Bankbetrag ÷ Fremdbetrag (6 Nachkommastellen).
 *  Divisor ist der VOLLE Fremdbetrag der Kartenzahlung (`bankForeignAmount`),
 *  falls angegeben — so bleibt der Kurs korrekt, wenn im Buchungsbetrag etwas
 *  rausgerechnet wurde (z. B. ein Privatkauf). Sonst der Buchungsbetrag selbst.
 *  `exchangeRate` darf null sein, wenn NUR ein Bankbetrag vorliegt. */
function effectiveRate(
  exchangeRate: number | null,
  rateSource: string | null,
  bankEurAmount: number | null,
  bankForeignAmount: number | null,
  originalTotal: number,
): { rate: number; source: string } {
  if (bankEurAmount != null && bankEurAmount > 0) {
    const divisor = bankForeignAmount != null && bankForeignAmount > 0 ? bankForeignAmount : originalTotal;
    if (divisor > 0) {
      return { rate: Math.round((bankEurAmount / divisor) * 1_000_000) / 1_000_000, source: "bank" };
    }
  }
  return { rate: exchangeRate ?? 0, source: rateSource ?? "live" };
}

/**
 * Exakter EUR-Betrag für einen Fremdbetrag bei nachgetragenem Bankbetrag —
 * OHNE Umweg über den auf 6 Stellen gerundeten Kurs (Fund C-4): `bankEur ×
 * Ziel-Fremdbetrag / Divisor`. Ohne Privatabzug (Divisor = voller Fremdbetrag)
 * trifft das den abgebuchten Euro-Betrag centgenau statt ±1 ct daneben.
 * Gibt null zurück, wenn kein Bankbetrag vorliegt (dann gilt der Kurs).
 */
function bankExactEur(
  targetForeign: number,
  bankEurAmount: number | null,
  bankForeignAmount: number | null,
  originalTotal: number,
): number | null {
  if (bankEurAmount == null || bankEurAmount <= 0) return null;
  const divisor = bankForeignAmount != null && bankForeignAmount > 0 ? bankForeignAmount : originalTotal;
  if (divisor <= 0) return null;
  return round2((bankEurAmount * targetForeign) / divisor);
}

export function resolveExpenseCurrency(input: {
  split_type: string;
  amount: number;
  alcohol_amount: number;
  tip_amount: number;
  original_currency: string | null;
  exchange_rate: number | null;
  rate_source: string | null;
  /** Tatsächlich abgebuchter Euro-Betrag laut Kontoauszug (optional, nachträglich). */
  bank_eur_amount: number | null;
  /** Voller Fremdbetrag der Kartenzahlung — nur nötig, wenn er vom Buchungsbetrag abweicht. */
  bank_foreign_amount: number | null;
  participant_amounts: { person_id: string; amount: number }[];
}): ResolvedExpenseCurrency {
  const isPerPerson = input.split_type === "per_person";
  const hasBank = input.bank_eur_amount != null && input.bank_eur_amount > 0;
  // Fremdwährung, sobald eine Währung + (Kurs ODER nachgetragener Bankbetrag)
  // vorliegt. Ohne beides würde ein Fremdbetrag sonst still als EUR verbucht.
  const foreign = input.original_currency != null && (input.exchange_rate != null || hasBank);
  const ppSubmitted = input.participant_amounts.filter((p) => p.amount > 0);

  if (!foreign) {
    const perPerson = ppSubmitted.map((p) => ({ person_id: p.person_id, amount: p.amount, original_amount: null }));
    return {
      amount: isPerPerson ? round2(perPerson.reduce((s, p) => s + p.amount, 0)) : input.amount,
      alcohol_amount: isPerPerson ? 0 : input.alcohol_amount,
      tip_amount: isPerPerson ? input.tip_amount : 0,
      original_currency: null,
      original_amount: null,
      exchange_rate: null,
      rate_source: null,
      perPerson,
    };
  }

  const originalTotal = isPerPerson
    ? round2(ppSubmitted.reduce((s, p) => s + p.amount, 0))
    : round2(input.amount);
  const { rate, source } = effectiveRate(
    input.exchange_rate,
    input.rate_source,
    input.bank_eur_amount,
    input.bank_foreign_amount,
    originalTotal,
  );

  if (isPerPerson) {
    const perPerson = ppSubmitted.map((p) => ({
      person_id: p.person_id,
      amount: foreignToEur(p.amount, rate),
      original_amount: p.amount,
    }));
    return {
      amount: round2(perPerson.reduce((s, p) => s + p.amount, 0)),
      alcohol_amount: 0,
      tip_amount: foreignToEur(input.tip_amount, rate),
      original_currency: input.original_currency,
      original_amount: originalTotal,
      exchange_rate: rate,
      rate_source: source,
      perPerson,
    };
  }
  // Bei Bankkurs den Buchungsbetrag centgenau aus dem Bankbetrag ableiten
  // (Fund C-4) statt über den gerundeten Kurs; Alkohol-Teil bleibt kursbasiert
  // (Sub-Split innerhalb des Betrags). Ohne Bankbetrag → Kurs-Umrechnung.
  const bankAmount = source === "bank"
    ? bankExactEur(input.amount, input.bank_eur_amount, input.bank_foreign_amount, originalTotal)
    : null;
  return {
    amount: bankAmount ?? foreignToEur(input.amount, rate),
    alcohol_amount: foreignToEur(input.alcohol_amount, rate),
    tip_amount: 0,
    original_currency: input.original_currency,
    original_amount: originalTotal,
    exchange_rate: rate,
    rate_source: source,
    perPerson: [],
  };
}

export function resolveCreditCurrency(input: {
  amount: number;
  original_currency: string | null;
  exchange_rate: number | null;
  rate_source: string | null;
  bank_eur_amount: number | null;
  bank_foreign_amount: number | null;
}): ExpenseCurrencyFields & { amount: number } {
  const hasBank = input.bank_eur_amount != null && input.bank_eur_amount > 0;
  if (input.original_currency == null || (input.exchange_rate == null && !hasBank)) {
    return { amount: input.amount, original_currency: null, original_amount: null, exchange_rate: null, rate_source: null };
  }
  const originalTotal = round2(input.amount);
  const { rate, source } = effectiveRate(
    input.exchange_rate,
    input.rate_source,
    input.bank_eur_amount,
    input.bank_foreign_amount,
    originalTotal,
  );
  const bankAmount = source === "bank"
    ? bankExactEur(input.amount, input.bank_eur_amount, input.bank_foreign_amount, originalTotal)
    : null;
  return {
    amount: bankAmount ?? foreignToEur(input.amount, rate),
    original_currency: input.original_currency,
    original_amount: originalTotal,
    exchange_rate: rate,
    rate_source: source,
  };
}
