import { describe, expect, it } from "vitest";
import {
  applyGlobalFilter,
  applyStatsFilter,
  categoryKey,
  listCategories,
  NONE_KEY,
  type GlobalRow,
  type StatsRow,
} from "@/lib/calc/stats-filter";

const row = (o: Partial<StatsRow> & { key: string; total: number }): StatsRow => ({
  date: "2026-05-01",
  name: o.key,
  icon: null,
  alcohol: 0,
  count: 1,
  ...o,
});

const rows: StatsRow[] = [
  row({ date: "2026-05-01", key: "food", name: "Lebensmittel", total: 100, alcohol: 20, count: 2 }),
  row({ date: "2026-05-02", key: "food", name: "Lebensmittel", total: 50, count: 1 }),
  row({ date: "2026-05-02", key: "port", name: "Hafen", total: 50, count: 1 }),
  row({ date: "2026-05-03", key: "bar", name: "Bar", total: 30, alcohol: 30, count: 1, pureAlcoholCount: 1 }),
];
const all = new Set(["food", "port", "bar"]);

describe("categoryKey", () => {
  it("normalisiert Name und mappt leer / Ohne Kategorie auf __none__", () => {
    expect(categoryKey("  Sprit ")).toBe("sprit");
    expect(categoryKey("SPRIT")).toBe("sprit");
    expect(categoryKey("Ohne Kategorie")).toBe(NONE_KEY);
    expect(categoryKey("")).toBe(NONE_KEY);
    expect(categoryKey(null)).toBe(NONE_KEY);
  });
});

describe("applyStatsFilter", () => {
  it("alle gewählt: Summen, Tage, Ø je Buchungstag, Prozente", () => {
    const r = applyStatsFilter(rows, { categories: all, excludeAlcohol: false });
    expect(r.total).toBe(230);
    expect(r.count).toBe(5);
    expect(r.days).toBe(3);
    expect(r.avgPerDay).toBeCloseTo(230 / 3);
    expect(r.byCategory.map((c) => c.key)).toEqual(["food", "port", "bar"]);
    expect(r.byCategory[0].pct).toBeCloseTo((150 / 230) * 100);
    expect(r.byCategory.reduce((s, c) => s + c.pct, 0)).toBeCloseTo(100);
    expect(r.maxCat).toBe(150);
    expect(r.maxDay).toBe(100);
  });

  it("Teilauswahl: Prozentbasis ist die gefilterte Summe, Tage nur mit Rest-Buchung", () => {
    const r = applyStatsFilter(rows, { categories: new Set(["port"]), excludeAlcohol: false });
    expect(r.total).toBe(50);
    expect(r.days).toBe(1);
    expect(r.avgPerDay).toBe(50);
    expect(r.byCategory).toHaveLength(1);
    expect(r.byCategory[0].pct).toBe(100);
    expect(r.byDay.map((d) => d.date)).toEqual(["2026-05-02"]);
  });

  it("Leerauswahl: alles 0, nie NaN, Untergrenze 1 für Balken", () => {
    const r = applyStatsFilter(rows, { categories: new Set(), excludeAlcohol: false });
    expect(r).toMatchObject({ total: 0, count: 0, days: 0, avgPerDay: 0, maxCat: 1, maxDay: 1 });
    expect(r.byCategory).toEqual([]);
    for (const v of [r.total, r.avgPerDay, r.maxCat, r.maxDay]) expect(Number.isNaN(v)).toBe(false);
  });

  it("Alkoholanteil heraus: Betrag - Alkohol; reine Alkohol-Zeile zählt weder als Buchung noch als Tag", () => {
    const r = applyStatsFilter(rows, { categories: all, excludeAlcohol: true });
    expect(r.total).toBe(180); // 80 + 50 + 50, Bar entfällt
    expect(r.count).toBe(4);
    expect(r.days).toBe(2);
    expect(r.byDay.map((d) => d.date)).toEqual(["2026-05-01", "2026-05-02"]);
    expect(r.byCategory.map((c) => c.key)).not.toContain("bar");
    expect(r.byCategory.every((c) => c.alcohol === 0)).toBe(true);
  });

  it("Alkohol heraus, nur Alkohol-Kategorie gewählt: leer ohne NaN", () => {
    const r = applyStatsFilter(rows, { categories: new Set(["bar"]), excludeAlcohol: true });
    expect(r.total).toBe(0);
    expect(r.days).toBe(0);
    expect(r.avgPerDay).toBe(0);
    expect(r.maxDay).toBe(1);
  });

  it("pureAlcoholCount reduziert die Buchungszahl einer gemischten Zeile", () => {
    const mixed = [
      row({ key: "food", total: 60, alcohol: 40, count: 3, pureAlcoholCount: 1 }),
    ];
    const r = applyStatsFilter(mixed, { categories: new Set(["food"]), excludeAlcohol: true });
    expect(r.total).toBe(20);
    expect(r.count).toBe(2);
  });

  it("zwei Zeilen mit gleichem Schlüssel (gleichnamige Kategorien) werden zusammengefasst", () => {
    const dup = [
      row({ date: "2026-05-01", key: "sprit", name: "Sprit", total: 10 }),
      row({ date: "2026-05-02", key: "sprit", name: "sprit", total: 15 }),
    ];
    const r = applyStatsFilter(dup, { categories: new Set(["sprit"]), excludeAlcohol: false });
    expect(r.byCategory).toHaveLength(1);
    expect(r.byCategory[0].total).toBe(25);
    expect(r.byCategory[0].count).toBe(2);
  });

  it("__none__ ist als eigene Kategorie wählbar", () => {
    const withNone = [
      ...rows,
      row({ key: NONE_KEY, name: "Ohne Kategorie", total: 10 }),
    ];
    const r = applyStatsFilter(withNone, { categories: new Set([NONE_KEY]), excludeAlcohol: false });
    expect(r.total).toBe(10);
    expect(r.byCategory[0].name).toBe("Ohne Kategorie");
  });
});

describe("listCategories", () => {
  it("fasst nach Schlüssel zusammen und sortiert nach Summe", () => {
    const c = listCategories(rows);
    expect(c.map((x) => x.key)).toEqual(["food", "port", "bar"]);
    expect(c[0].total).toBe(150);
  });
});

describe("applyGlobalFilter", () => {
  const trips = [
    { trip_id: "a", name: "A", start_date: "2025-05-01", end_date: "2025-05-08", purged: false },
    { trip_id: "b", name: "B", start_date: "2026-05-01", end_date: "2026-05-08", purged: true },
  ];
  const g = (o: Partial<GlobalRow> & { trip_id: string; key: string; total: number }): GlobalRow => ({
    year: o.trip_id === "a" ? "2025" : "2026",
    name: o.key,
    icon: null,
    alcohol: 0,
    count: 1,
    ...o,
  });
  const grows = [
    g({ trip_id: "a", key: "food", total: 100, count: 4 }),
    g({ trip_id: "a", key: "port", total: 40 }),
    g({ trip_id: "b", key: "food", total: 60, alcohol: 60, count: 2, pureAlcoholCount: 2 }),
  ];

  it("leitet Törn-Anzahl, Ø pro Törn, Jahre aus der Auswahl ab und blendet leere Törns aus", () => {
    const r = applyGlobalFilter(grows, trips, { categories: new Set(["port"]), excludeAlcohol: false });
    expect(r.total).toBe(40);
    expect(r.tripCount).toBe(1);
    expect(r.avgPerTrip).toBe(40);
    expect(r.byTrip.map((t) => t.trip_id)).toEqual(["a"]);
    expect(r.byYear.map((y) => y.year)).toEqual(["2025"]);
    expect(r.byYear[0].tripCount).toBe(1);
  });

  it("Alkohol heraus entfernt Törn mit nur Alkohol und korrigiert die Buchungszahl", () => {
    const all2 = new Set(["food", "port"]);
    const r = applyGlobalFilter(grows, trips, { categories: all2, excludeAlcohol: true });
    expect(r.total).toBe(140);
    expect(r.count).toBe(5);
    expect(r.tripCount).toBe(1);
    expect(r.byYear).toHaveLength(1);
  });

  it("Leerauswahl: 0 ohne NaN", () => {
    const r = applyGlobalFilter(grows, trips, { categories: new Set(), excludeAlcohol: false });
    expect(r).toMatchObject({ total: 0, tripCount: 0, avgPerTrip: 0, maxCat: 1, maxTrip: 1, maxYear: 1 });
  });

  it("Gesamt über alle: Prozente summieren zu 100", () => {
    const r = applyGlobalFilter(grows, trips, { categories: new Set(["food", "port"]), excludeAlcohol: false });
    expect(r.tripCount).toBe(2);
    expect(r.byCategory.reduce((s, c) => s + c.pct, 0)).toBeCloseTo(100);
  });
});
