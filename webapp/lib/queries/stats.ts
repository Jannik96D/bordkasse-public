import { readClient } from "@/lib/supabase/read-client";

export type CategoryStat = {
  category_id: string | null;
  category_name: string;
  /** Icon-Name aus der Whitelist; null bei "Ohne Kategorie" oder nach DSGVO-Purge. */
  category_icon: string | null;
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
  category: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
};

const first = <T,>(v: T | T[] | null): T | null =>
  v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

/**
 * Aggregiert die Ausgaben eines Trips nach Kategorie und Datum.
 *
 * - Solange der Trip "lebt" (transactions vorhanden, retention_purged_at = NULL):
 *   live aggregiert aus transactions.
 * - Nach DSGVO-Purge (retention_purged_at IS NOT NULL): aus dem
 *   anonymisierten Aggregat trip_statistics, das vor der Löschung
 *   geschrieben wurde.
 *
 * Gutschriften werden ignoriert — wir wollen "wofür wurde Geld ausgegeben".
 */
export async function getTripStats(tripId: string): Promise<StatsSummary> {
  const supabase = await readClient();

  // Prüfen, ob der Trip schon archiviert/gepurged ist
  const { data: tripRow } = await supabase
    .from("trips")
    .select("retention_purged_at")
    .eq("id", tripId)
    .maybeSingle();

  if (tripRow?.retention_purged_at) {
    return getPurgedStats(supabase, tripId);
  }

  return getLiveStats(supabase, tripId);
}

type SupabaseLike = Awaited<ReturnType<typeof readClient>>;

async function getLiveStats(supabase: SupabaseLike, tripId: string): Promise<StatsSummary> {
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      id, date, amount, alcohol_amount, category_id,
      category:trip_categories(name, icon)
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

    const catKey = r.category_id ?? "__none__";
    const cat = first(r.category);
    const catName = cat?.name ?? "Ohne Kategorie";
    const catIcon = cat?.icon ?? null;
    const catBucket = catMap.get(catKey) ?? {
      category_id: r.category_id,
      category_name: catName,
      category_icon: catIcon,
      total: 0,
      alcohol: 0,
      count: 0,
    };
    catBucket.total += amount;
    catBucket.alcohol += alcohol;
    catBucket.count += 1;
    catMap.set(catKey, catBucket);

    const dayBucket = dayMap.get(r.date) ?? { date: r.date, total: 0, alcohol: 0, count: 0 };
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

async function getPurgedStats(supabase: SupabaseLike, tripId: string): Promise<StatsSummary> {
  const { data, error } = await supabase
    .from("trip_statistics")
    .select("date, category_name, total_amount, alcohol_amount, count")
    .eq("trip_id", tripId)
    .order("date", { ascending: true });

  if (error || !data) {
    return { total: 0, alcoholTotal: 0, count: 0, days: 0, byCategory: [], byDay: [] };
  }

  let total = 0;
  let alcoholTotal = 0;
  let countTotal = 0;
  const catMap = new Map<string, CategoryStat>();
  const dayMap = new Map<string, DayStat>();

  for (const r of data) {
    const amount = Number(r.total_amount);
    const alcohol = Number(r.alcohol_amount ?? 0);
    const c = r.count;
    total += amount;
    alcoholTotal += alcohol;
    countTotal += c;

    const catBucket = catMap.get(r.category_name) ?? {
      category_id: null,
      category_name: r.category_name,
      category_icon: null, // anonymisiertes Aggregat enthält kein Icon
      total: 0,
      alcohol: 0,
      count: 0,
    };
    catBucket.total += amount;
    catBucket.alcohol += alcohol;
    catBucket.count += c;
    catMap.set(r.category_name, catBucket);

    const dayBucket = dayMap.get(r.date) ?? { date: r.date, total: 0, alcohol: 0, count: 0 };
    dayBucket.total += amount;
    dayBucket.alcohol += alcohol;
    dayBucket.count += c;
    dayMap.set(r.date, dayBucket);
  }

  const byCategory = Array.from(catMap.values()).sort((a, b) => b.total - a.total);
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    total,
    alcoholTotal,
    count: countTotal,
    days: byDay.length,
    byCategory,
    byDay,
  };
}
