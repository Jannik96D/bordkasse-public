import { readClient } from "@/lib/supabase/read-client";
import { categoryKey, NONE_NAME, type StatsRow } from "@/lib/calc/stats-filter";
import { fetchAllRows } from "@/lib/queries/paginate";

/** Rohdaten der Pro-Törn-Statistik; Filter/Aggregation passieren im Client. */
export type TripStatsData = {
  rows: StatsRow[];
  /** true = DSGVO-gepurgt, Zeilen stammen aus `trip_statistics`. */
  purged: boolean;
};

type TxRow = {
  id: string;
  date: string;
  amount: number | string;
  alcohol_amount: number | string | null;
  category: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
};

const first = <T,>(v: T | T[] | null): T | null =>
  v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

/** Betrag abzüglich Alkoholanteil unter einem halben Cent = reine Alkohol-Buchung. */
const isPureAlcohol = (amount: number, alcohol: number) => amount - alcohol < 0.005;

/**
 * Liefert die Ausgaben eines Törns als flache Zeilen je (Tag, Kategorie).
 *
 * - Solange der Törn „lebt" (retention_purged_at = NULL): live aus
 *   transactions (nur type=expense, deleted_at IS NULL).
 * - Nach DSGVO-Purge: aus dem anonymisierten Aggregat trip_statistics.
 *
 * Aggregiert wird nach (Datum, normalisierter Kategorie-NAME) — nicht nach
 * category_id —, damit Chip und Balken dieselbe Menge meinen und der
 * Purge-Pfad (kennt nur Namen) konsistent bleibt. Gutschriften werden
 * ignoriert; Trinkgeld ist nie enthalten.
 */
export async function getTripStats(tripId: string): Promise<TripStatsData> {
  const supabase = await readClient();

  const { data: tripRow } = await supabase
    .from("trips")
    .select("retention_purged_at")
    .eq("id", tripId)
    .maybeSingle();

  if (tripRow?.retention_purged_at) {
    return { rows: await getPurgedRows(supabase, tripId), purged: true };
  }
  return { rows: await getLiveRows(supabase, tripId), purged: false };
}

type SupabaseLike = Awaited<ReturnType<typeof readClient>>;

async function getLiveRows(supabase: SupabaseLike, tripId: string): Promise<StatsRow[]> {
  const data = await fetchAllRows<TxRow>((from, to) =>
    supabase
      .from("transactions")
      .select(`id, date, amount, alcohol_amount, category:trip_categories(name, icon)`)
      .eq("trip_id", tripId)
      .eq("type", "expense")
      .is("deleted_at", null)
      .order("date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TxRow[] | null; error: unknown }>,
  );

  const map = new Map<string, StatsRow>();
  for (const r of data) {
    const amount = Number(r.amount);
    const alcohol = Number(r.alcohol_amount ?? 0);
    const cat = first(r.category);
    const name = cat?.name?.trim() || NONE_NAME;
    const key = categoryKey(name);
    const k = `${r.date}|${key}`;
    const row = map.get(k) ?? {
      date: r.date,
      key,
      name,
      icon: cat?.icon ?? null,
      total: 0,
      alcohol: 0,
      count: 0,
      pureAlcoholCount: 0,
    };
    row.total += amount;
    row.alcohol += alcohol;
    row.count += 1;
    if (isPureAlcohol(amount, alcohol)) row.pureAlcoholCount = (row.pureAlcoholCount ?? 0) + 1;
    if (!row.icon && cat?.icon) row.icon = cat.icon;
    map.set(k, row);
  }
  return Array.from(map.values());
}

async function getPurgedRows(supabase: SupabaseLike, tripId: string): Promise<StatsRow[]> {
  type P = {
    date: string;
    category_name: string;
    total_amount: number | string;
    alcohol_amount: number | string | null;
    count: number;
  };
  const data = await fetchAllRows<P>((from, to) =>
    supabase
      .from("trip_statistics")
      .select("date, category_name, total_amount, alcohol_amount, count")
      .eq("trip_id", tripId)
      .order("date", { ascending: true })
      .order("category_name", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: P[] | null; error: unknown }>,
  );

  const map = new Map<string, StatsRow>();
  for (const r of data) {
    const key = categoryKey(r.category_name);
    const k = `${r.date}|${key}`;
    const row = map.get(k) ?? {
      date: r.date,
      key,
      name: r.category_name?.trim() || NONE_NAME,
      icon: null, // anonymisiertes Aggregat enthält kein Icon
      total: 0,
      alcohol: 0,
      count: 0,
    };
    row.total += Number(r.total_amount);
    row.alcohol += Number(r.alcohol_amount ?? 0);
    row.count += r.count;
    map.set(k, row);
  }
  return Array.from(map.values());
}
