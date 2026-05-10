import { createClient } from "@/lib/supabase/server";

export type CategoryStat = {
  category_id: string | null;
  category_name: string;
  total: number;
  alcohol: number;
  count: number;
};

export type DayStat = {
  date: string;
  total: number;
  alcohol: number;
  count: number;
};

export type StatsSummary = {
  total: number;
  alcoholTotal: number;
  count: number;
  days: number;
  byCategory: CategoryStat[];
  byDay: DayStat[];
};

type TxRow = {
  id: string;
  date: string;
  amount: number | string;
  alcohol_amount: number | string | null;
  category_id: string | null;
  category: { name: string } | { name: string }[] | null;
};

const first = <T,>(v: T | T[] | null): T | null =>
  v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

/**
 * Aggregiert alle aktiven Ausgaben eines Trips nach Kategorie und Datum.
 * Gutschriften werden ignoriert — wir wollen "wofür wurde Geld ausgegeben".
 */
export async function getTripStats(tripId: string): Promise<StatsSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      id, date, amount, alcohol_amount, category_id,
      category:trip_categories(name)
    `)
    .eq("trip_id", tripId)
    .eq("type", "expense")
    .is("deleted_at", null)
    .order("date", { ascending: true });

  if (error || !data) {
    return { total: 0, alcoholTotal: 0, count: 0, days: 0, byCategory: [], byDay: [] };
  }

  const rows = data as unknown as TxRow[];

  let total = 0;
  let alcoholTotal = 0;

  const catMap = new Map<string, CategoryStat>();
  const dayMap = new Map<string, DayStat>();

  for (const r of rows) {
    const amount = Number(r.amount);
    const alcohol = Number(r.alcohol_amount ?? 0);
    total += amount;
    alcoholTotal += alcohol;

    // Kategorie-Bucket: null/unbekannt landet unter "Ohne Kategorie"
    const catKey = r.category_id ?? "__none__";
    const catName = first(r.category)?.name ?? "Ohne Kategorie";
    const catBucket = catMap.get(catKey) ?? {
      category_id: r.category_id,
      category_name: catName,
      total: 0,
      alcohol: 0,
      count: 0,
    };
    catBucket.total += amount;
    catBucket.alcohol += alcohol;
    catBucket.count += 1;
    catMap.set(catKey, catBucket);

    // Tagesbucket
    const dayBucket = dayMap.get(r.date) ?? {
      date: r.date,
      total: 0,
      alcohol: 0,
      count: 0,
    };
    dayBucket.total += amount;
    dayBucket.alcohol += alcohol;
    dayBucket.count += 1;
    dayMap.set(r.date, dayBucket);
  }

  const byCategory = Array.from(catMap.values()).sort((a, b) => b.total - a.total);
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    total,
    alcoholTotal,
    count: rows.length,
    days: byDay.length,
    byCategory,
    byDay,
  };
}
