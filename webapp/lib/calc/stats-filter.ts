/**
 * Reine Filter-/Aggregationslogik der Statistik (Pro-Törn und Gesamtstatistik).
 *
 * Die Queries liefern flache, vorab nach (Tag, Kategorie) bzw. (Törn,
 * Kategorie) aggregierte Zeilen; Auswahl von Kategorien und das Herausrechnen
 * des Alkoholanteils passieren client-seitig und rechnen Gesamt, Ø, Balken
 * und Prozente aus genau dieser Auswahl neu.
 *
 * Kategorie-Schlüssel = normalisierter Name (nicht category_id): der
 * DSGVO-Purge-Pfad kennt nur Namen, Chip und Balken sollen dieselbe Menge
 * meinen, und zwei gleichnamige Kategorien werden so zusammengefasst.
 */

export const NONE_KEY = "__none__";
export const NONE_NAME = "Ohne Kategorie";

/** Normalisierter Kategorie-Schlüssel; leer / „Ohne Kategorie" → `__none__`. */
export function categoryKey(name: string | null | undefined): string {
  const n = (name ?? "").trim().toLowerCase();
  if (n === "" || n === NONE_NAME.toLowerCase()) return NONE_KEY;
  return n;
}

/** Eine vorab aggregierte Zeile. */
export type StatsRow = {
  /** ISO-Datum; nur im Pro-Törn-Pfad belegt (für „Nach Tag"). */
  date?: string;
  key: string;
  name: string;
  icon: string | null;
  total: number;
  alcohol: number;
  count: number;
  /**
   * Anzahl Buchungen dieser Zeile, die NUR aus Alkohol bestehen
   * (Betrag − Alkoholanteil ≈ 0). Beim Herausrechnen zählen sie weder als
   * Buchung noch als Tag. Gepurgte Aggregate kennen das nicht (→ 0).
   */
  pureAlcoholCount?: number;
};

export type StatsOptions = {
  /** Gewählte Kategorie-Schlüssel. Leer = nichts gewählt (nie „alle"). */
  categories: ReadonlySet<string>;
  excludeAlcohol: boolean;
};

export type CategoryResult = {
  key: string;
  name: string;
  icon: string | null;
  total: number;
  alcohol: number;
  count: number;
  /** Anteil an der gefilterten Summe, 0–100. */
  pct: number;
};

export type DayResult = {
  date: string;
  total: number;
  alcohol: number;
  count: number;
};

export type StatsResult = {
  total: number;
  count: number;
  /** Tage mit mindestens einer verbleibenden Buchung. */
  days: number;
  /** Summe / Buchungstage; 0 bei 0 Tagen. */
  avgPerDay: number;
  byCategory: CategoryResult[];
  byDay: DayResult[];
  /** Skalierung der Balken, Untergrenze 1 (nie Division durch 0). */
  maxCat: number;
  maxDay: number;
};

const EPS = 0.005;

/** Effektive Werte einer Zeile oder null, wenn sie komplett wegfällt. */
export function effectiveRow(
  r: StatsRow,
  excludeAlcohol: boolean,
): { total: number; alcohol: number; count: number } | null {
  if (!excludeAlcohol) return { total: r.total, alcohol: r.alcohol, count: r.count };
  const rest = r.total - r.alcohol;
  if (rest < EPS) return null;
  const count = Math.max(r.count - (r.pureAlcoholCount ?? 0), 0);
  return { total: rest, alcohol: 0, count };
}

/** Alle Kategorien der Zeilen (für die Chips), nach Summe absteigend. */
export function listCategories(
  rows: readonly StatsRow[],
): { key: string; name: string; icon: string | null; total: number }[] {
  const map = new Map<string, { key: string; name: string; icon: string | null; total: number }>();
  for (const r of rows) {
    const c = map.get(r.key) ?? { key: r.key, name: r.name, icon: r.icon, total: 0 };
    c.total += r.total;
    if (!c.icon && r.icon) c.icon = r.icon;
    map.set(r.key, c);
  }
  return Array.from(map.values()).sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name, "de"),
  );
}

export function applyStatsFilter(
  rows: readonly StatsRow[],
  { categories, excludeAlcohol }: StatsOptions,
): StatsResult {
  let total = 0;
  let count = 0;
  const catMap = new Map<string, Omit<CategoryResult, "pct">>();
  const dayMap = new Map<string, DayResult>();

  for (const r of rows) {
    if (!categories.has(r.key)) continue;
    const e = effectiveRow(r, excludeAlcohol);
    if (!e) continue;
    total += e.total;
    count += e.count;

    const cat = catMap.get(r.key) ?? {
      key: r.key,
      name: r.name,
      icon: r.icon,
      total: 0,
      alcohol: 0,
      count: 0,
    };
    cat.total += e.total;
    cat.alcohol += e.alcohol;
    cat.count += e.count;
    if (!cat.icon && r.icon) cat.icon = r.icon;
    catMap.set(r.key, cat);

    if (r.date) {
      const day = dayMap.get(r.date) ?? { date: r.date, total: 0, alcohol: 0, count: 0 };
      day.total += e.total;
      day.alcohol += e.alcohol;
      day.count += e.count;
      dayMap.set(r.date, day);
    }
  }

  const byCategory: CategoryResult[] = Array.from(catMap.values())
    .map((c) => ({ ...c, pct: total > 0 ? (c.total / total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const days = byDay.length;

  return {
    total,
    count,
    days,
    avgPerDay: days > 0 ? total / days : 0,
    byCategory,
    byDay,
    maxCat: Math.max(...byCategory.map((c) => c.total), 1),
    maxDay: Math.max(...byDay.map((d) => d.total), 1),
  };
}

// ── Gesamtstatistik ────────────────────────────────────────────────────

export type GlobalRow = StatsRow & { trip_id: string; year: string };

export type GlobalTripMeta = {
  trip_id: string;
  name: string;
  start_date: string;
  end_date: string;
  purged: boolean;
};

export type GlobalTripResult = GlobalTripMeta & { total: number; count: number };
export type GlobalYearResult = { year: string; total: number; count: number; tripCount: number };

export type GlobalResult = {
  total: number;
  count: number;
  tripCount: number;
  avgPerTrip: number;
  byCategory: CategoryResult[];
  byTrip: GlobalTripResult[];
  byYear: GlobalYearResult[];
  maxCat: number;
  maxTrip: number;
  maxYear: number;
};

export function applyGlobalFilter(
  rows: readonly GlobalRow[],
  trips: readonly GlobalTripMeta[],
  { categories, excludeAlcohol }: StatsOptions,
): GlobalResult {
  const meta = new Map(trips.map((t) => [t.trip_id, t]));
  let total = 0;
  let count = 0;
  const catMap = new Map<string, Omit<CategoryResult, "pct">>();
  const tripMap = new Map<string, GlobalTripResult>();
  const yearMap = new Map<string, GlobalYearResult>();
  const yearTrips = new Map<string, Set<string>>();

  for (const r of rows) {
    if (!categories.has(r.key)) continue;
    const e = effectiveRow(r, excludeAlcohol);
    if (!e) continue;
    total += e.total;
    count += e.count;

    const cat = catMap.get(r.key) ?? {
      key: r.key,
      name: r.name,
      icon: r.icon,
      total: 0,
      alcohol: 0,
      count: 0,
    };
    cat.total += e.total;
    cat.alcohol += e.alcohol;
    cat.count += e.count;
    if (!cat.icon && r.icon) cat.icon = r.icon;
    catMap.set(r.key, cat);

    const m = meta.get(r.trip_id);
    if (m) {
      const t = tripMap.get(r.trip_id) ?? { ...m, total: 0, count: 0 };
      t.total += e.total;
      t.count += e.count;
      tripMap.set(r.trip_id, t);
    }

    const y = yearMap.get(r.year) ?? { year: r.year, total: 0, count: 0, tripCount: 0 };
    y.total += e.total;
    y.count += e.count;
    yearMap.set(r.year, y);
    const set = yearTrips.get(r.year) ?? new Set<string>();
    set.add(r.trip_id);
    yearTrips.set(r.year, set);
  }

  for (const [year, set] of yearTrips) yearMap.get(year)!.tripCount = set.size;

  const byCategory: CategoryResult[] = Array.from(catMap.values())
    .map((c) => ({ ...c, pct: total > 0 ? (c.total / total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
  const byTrip = Array.from(tripMap.values()).sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
  const byYear = Array.from(yearMap.values()).sort((a, b) => b.year.localeCompare(a.year));
  const tripCount = byTrip.length;

  return {
    total,
    count,
    tripCount,
    avgPerTrip: tripCount > 0 ? total / tripCount : 0,
    byCategory,
    byTrip,
    byYear,
    maxCat: Math.max(...byCategory.map((c) => c.total), 1),
    maxTrip: Math.max(...byTrip.map((t) => t.total), 1),
    maxYear: Math.max(...byYear.map((y) => y.total), 1),
  };
}
