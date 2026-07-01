import { currencyLabel } from "./currencies";

/**
 * Eine in der Buchungsmaske wählbare Währung + Default-Kurs (client-sichere
 * Spiegelung von lib/rates/currency-options; hier definiert, damit die reine
 * Helferlogik ohne Client-Modul importier- und testbar bleibt).
 */
export type CurrencyChoice = {
  code: string;
  label: string;
  /** EUR pro 1 Einheit Fremdwährung. null = kein Kurs verfügbar. */
  rate: number | null;
  source: "live" | "last_booking" | null;
};

/**
 * Stellt sicher, dass die eigene Währung einer bereits gespeicherten Buchung als
 * Option vorhanden ist — AUCH wenn der Törn sie inzwischen nicht mehr aktiviert
 * hat. Ohne das würde beim Bearbeiten der Währungswähler fehlen, das Formular
 * den Fremdbetrag ohne Währungs-Kontext absenden und der Server die Buchung als
 * Euro verbuchen (stille Bilanzverfälschung). Der gespeicherte Kurs wird als
 * Default mitgegeben.
 */
export function withBookingCurrency(
  options: CurrencyChoice[],
  currency: string | null | undefined,
  rate: number | null | undefined,
): CurrencyChoice[] {
  if (!currency || currency === "EUR" || options.some((o) => o.code === currency)) {
    return options;
  }
  return [
    ...options,
    { code: currency, label: currencyLabel(currency), rate: rate ?? null, source: "last_booking" },
  ];
}
