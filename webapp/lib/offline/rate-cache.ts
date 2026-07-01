/**
 * Persistenter Client-Cache für Wechselkurse (Migration 0041), damit die ERSTE
 * Offline-Buchung einer Währung bereits einen Kurs hat — auch wenn es dafür
 * noch keine frühere Buchung auf dem Törn gibt.
 *
 * Hintergrund: `getCurrencyOptions` liefert den Live-/Letzte-Buchung-Kurs nur
 * beim (Online-)Server-Render. Wird der Törn online geöffnet, schreibt die
 * Buchungsmaske die Kurse hier in localStorage; geht das Gerät danach offline,
 * greift `getCachedRate` als Fallback, bevor das Formular eine manuelle Eingabe
 * verlangt. localStorage (nicht IndexedDB), weil die Daten winzig sind und der
 * synchrone Zugriff die Kurs-Vorbelegung ohne Ladezustand erlaubt.
 *
 * Fallback-Reihenfolge im Formular:
 *   Server-Default (live / letzte Buchung)  →  dieser Cache  →  manuelle Eingabe.
 */
const STORAGE_KEY = "bordkasse:rates:v1";

// { [tripId]: { [currencyCode]: rateEurPerUnit } }
type RateStore = Record<string, Record<string, number>>;

function read(): RateStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RateStore) : {};
  } catch {
    return {};
  }
}

/** Kurse eines Törns cachen (nur Einträge mit gültigem Kurs). No-op ohne window. */
export function cacheRates(tripId: string, entries: { code: string; rate: number }[]): void {
  if (typeof window === "undefined" || entries.length === 0) return;
  try {
    const store = read();
    const trip = store[tripId] ?? {};
    for (const e of entries) {
      if (Number.isFinite(e.rate) && e.rate > 0) trip[e.code] = e.rate;
    }
    store[tripId] = trip;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Speicher voll / privater Modus → still ignorieren, Formular fällt auf
    // manuelle Eingabe zurück.
  }
}

/** Gecachten Kurs (EUR pro 1 Einheit) für Törn+Währung, sonst null. */
export function getCachedRate(tripId: string, code: string): number | null {
  const rate = read()[tripId]?.[code];
  return typeof rate === "number" && rate > 0 ? rate : null;
}
