import "server-only";

/**
 * Live-Wechselkurse (Variante B: Kurs je Buchung). Ein einziger Call an
 * open.er-api.com (EUR-Basis, kostenlos, kein API-Key) liefert alle Kurse;
 * wir picken die auf dem Törn aktivierten heraus und invertieren sie zu
 * „EUR pro 1 Einheit Fremdwährung".
 *
 * Server-seitig, weil die Produktions-CSP `connect-src` nur `self` + Supabase
 * erlaubt — ein Browser-Fetch nach api.frankfurter/er-api würde geblockt.
 *
 * Fehlt das Netz oder schlägt der Abruf fehl, liefert die Funktion `{}` — der
 * Aufrufer (getCurrencyOptions) fällt dann auf den Kurs der letzten Buchung
 * derselben Währung zurück.
 */
const RATES_URL = "https://open.er-api.com/v6/latest/EUR";
const FETCH_TIMEOUT_MS = 3500;
// Kurse bewegen sich innerhalb einer Stunde praktisch nicht — der Next-Data-
// Cache schont die kostenlose API, ohne dass es sich „veraltet" anfühlt.
const CACHE_TTL_SECONDS = 1800;

interface ErApiResponse {
  result?: string;
  rates?: Record<string, number>;
}

/**
 * @returns Map ISO-Code → EUR-pro-Einheit (6 Nachkommastellen). Nur Codes, die
 * der Anbieter kennt, sind enthalten; unbekannte/fehlgeschlagene fehlen.
 */
export async function getLiveRates(currencies: string[]): Promise<Record<string, number>> {
  if (currencies.length === 0) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(RATES_URL, {
      signal: controller.signal,
      next: { revalidate: CACHE_TTL_SECONDS },
    });
    clearTimeout(timer);
    if (!res.ok) return {};
    const json = (await res.json()) as ErApiResponse;
    if (json.result !== "success" || !json.rates) return {};
    const out: Record<string, number> = {};
    for (const code of currencies) {
      const unitsPerEur = json.rates[code]; // 1 EUR = unitsPerEur × <code>
      if (typeof unitsPerEur === "number" && unitsPerEur > 0) {
        // EUR pro 1 Einheit Fremdwährung, auf 6 Nachkommastellen.
        out[code] = Math.round((1 / unitsPerEur) * 1_000_000) / 1_000_000;
      }
    }
    return out;
  } catch {
    return {};
  }
}
