/**
 * Kuratierte Liste der auf einem Törn wählbaren Fremdwährungen.
 *
 * Bewusst kuratiert (statt freier ISO-Eingabe), damit die Auswahl für die
 * nicht-technikaffine Crew übersichtlich bleibt. Alle Codes sind vom
 * Kurs-Anbieter (open.er-api.com, EUR-Basis) abgedeckt — inkl. der Exoten
 * für Karibik/Indischer Ozean/Pazifik. XPF ist fest an den Euro gekoppelt
 * (1 € = 119,3317 XPF), der Anbieter liefert den Kurs trotzdem live mit.
 *
 * EUR selbst steht NICHT in der Liste — es ist die Basiswährung; „keine
 * Fremdwährung" = EUR.
 */
export interface CurrencyDef {
  code: string;
  label: string;
  region: string;
}

export const FOREIGN_CURRENCIES: CurrencyDef[] = [
  { code: "DKK", label: "Dänische Krone", region: "Europa" },
  { code: "SEK", label: "Schwedische Krone", region: "Europa" },
  { code: "NOK", label: "Norwegische Krone", region: "Europa" },
  { code: "GBP", label: "Britisches Pfund", region: "Europa" },
  { code: "CHF", label: "Schweizer Franken", region: "Europa" },
  { code: "PLN", label: "Polnischer Złoty", region: "Europa" },
  { code: "BGN", label: "Bulgarischer Lew", region: "Europa" },
  { code: "ISK", label: "Isländische Krone", region: "Europa" },
  { code: "TRY", label: "Türkische Lira", region: "Europa" },
  { code: "ALL", label: "Albanischer Lek", region: "Europa" },
  { code: "USD", label: "US-Dollar", region: "Amerika" },
  { code: "CAD", label: "Kanadischer Dollar", region: "Amerika" },
  { code: "MXN", label: "Mexikanischer Peso", region: "Amerika" },
  { code: "XCD", label: "Ostkaribischer Dollar", region: "Karibik" },
  { code: "BBD", label: "Barbados-Dollar", region: "Karibik" },
  { code: "BSD", label: "Bahamas-Dollar", region: "Karibik" },
  { code: "DOP", label: "Dominikanischer Peso", region: "Karibik" },
  { code: "MUR", label: "Mauritius-Rupie", region: "Indischer Ozean" },
  { code: "SCR", label: "Seychellen-Rupie", region: "Indischer Ozean" },
  { code: "THB", label: "Thailändischer Baht", region: "Asien" },
  { code: "XPF", label: "CFP-Franc (Polynesien)", region: "Pazifik" },
];

export const FOREIGN_CURRENCY_CODES: string[] = FOREIGN_CURRENCIES.map((c) => c.code);

/** Ist der Code eine unterstützte Fremdwährung? */
export function isSupportedCurrency(code: string): boolean {
  return FOREIGN_CURRENCY_CODES.includes(code);
}

/** Deutsches Label zu einem Code („SEK" → „Schwedische Krone"); Fallback = Code. */
export function currencyLabel(code: string): string {
  return FOREIGN_CURRENCIES.find((c) => c.code === code)?.label ?? code;
}
