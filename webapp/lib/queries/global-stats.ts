import { readClient } from "@/lib/supabase/read-client";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import type { CategoryStat } from "@/lib/queries/stats";

export type TripStat = {
  trip_id: string;
  name: string;
  start_date: string;
  end_date: string;
  total: number;
  count: number;
  /** true = Trip ist DSGVO-gepurged, Aggregat stammt aus trip_statistics. */
  purged: boolean;
};

export type YearStat = {
  year: string;
  total: number;
  count: number;
  tripCount: number;
};

export type GlobalStats = {
  total: number;
  count: number;
  tripCount: number;
  avgPerTrip: number;
  byCategory: CategoryStat[];
  byTrip: TripStat[];
  byYear: YearStat[];
};

const EMPTY: GlobalStats = {
  total: 0,
  count: 0,
  tripCount: 0,
  avgPerTrip: 0,
  byCategory: [],
  byTrip: [],
  byYear: [],
};

type LiveTxRow = {
  trip_id: string;
  date: string;
  amount: number | string;
  alcohol_amount: number | string | null;
  category: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
};

type PurgedRow = {
  trip_id: string;
  date: string;
  category_name: string;
  total_amount: number | string;
  alcohol_amount: number | string | null;
  count: number;
};

const first = <T,>(v: T | T[] | null): T | null =>
  v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

/**
 * Aggregiert Ausgaben über ALLE Trips, die der eingeloggte User sehen darf:
 *   - Reguläre User: Trips, in denen sie Crew sind oder waren (Letzteres via
 *     RLS-Audience-Policy für gepurgte Trips, siehe Migration 0020).
 *   - Admins: alle Trips (Service-Role-Bypass über `readClient()`).
 *
 * Datenquelle gemischt:
 *   - Aktive Trips (retention_purged_at IS NULL) → live aus `transactions`
 *     (type=expense, deleted_at IS NULL).
 *   - Gepurgte Trips (retention_purged_at IS NOT NULL) → anonymisiertes
 *     Aggregat aus `trip_statistics`.
 *
 * Liefert vier Bucket-Listen für die /stats-Seite. Sortierungen:
 *   - byCategory  → total DESC
 *   - byTrip      → start_date DESC
 *   - byYear      → year DESC
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  const person = await getCurrentPerson();
  if (!person) return EMPTY;

  const supabase = await readClient();

  // 1. Alle für den User sichtbaren Trips holen (RLS filtert für Reguläre,
  //    Admin sieht alles via Service-Role).
  const { data: tripsRaw } = await supabase
    .from("trips")
    .select("id, name, start_date, end_date, retention_purged_at")
    .order("start_date", { ascending: false });

  const trips = (tripsRaw ?? []) as Array<{
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    retention_purged_at: string | null;
  }>;
  if (trips.length === 0) return EMPTY;

  // Trip-Metadaten in ein Lookup für die Reducer.
  const tripMeta = new Map<string, typeof trips[number]>();
  for (const t of trips) tripMeta.set(t.id, t);

  const liveIds = trips.filter((t) => !t.retention_purged_at).map((t) => t.id);
  const purgedIds = trips.filter((t) => t.retention_purged_at).map((t) => t.id);

  // Reducer-Akkumulatoren
  const byCategory = new Map<string, CategoryStat>();
  const byTrip = new Map<string, TripStat>();
  const byYear = new Map<string, YearStat>();
  let total = 0;
  let count = 0;

  // Trip-Bucket initialisieren — alle sichtbaren Trips, damit der Bucket
  // auch dann existiert, wenn der Trip 0 Buchungen hat (am Ende filtern
  // wir leere wieder raus).
  for (const t of trips) {
    byTrip.set(t.id, {
      trip_id: t.id,
      name: t.name,
      start_date: t.start_date,
      end_date: t.end_date,
      total: 0,
      count: 0,
      purged: !!t.retention_purged_at,
    });
  }

  // Year-Bucket vorbelegen mit tripCount (zählt sichtbare Trips, auch leere).
  for (const t of trips) {
    const year = t.start_date.slice(0, 4);
    const bucket = byYear.get(year) ?? {
      year,
      total: 0,
      count: 0,
      tripCount: 0,
    };
    bucket.tripCount += 1;
    byYear.set(year, bucket);
  }

  // 2. Live-Aggregation (aktive Trips)
  if (liveIds.length > 0) {
    const { data: liveRaw } = await supabase
      .from("transactions")
      .select(`
        trip_id, date, amount, alcohol_amount,
        category:trip_categories(name, icon)
      `)
      .in("trip_id", liveIds)
      .eq("type", "expense")
      .is("deleted_at", null);

    for (const r of (liveRaw ?? []) as unknown as LiveTxRow[]) {
      const amount = Number(r.amount);
      const alcohol = Number(r.alcohol_amount ?? 0);
      total += amount;
      count += 1;

      const cat = first(r.category);
      const catName = cat?.name ?? "Ohne Kategorie";
      const catIcon = cat?.icon ?? null;
      const cb = byCategory.get(catName) ?? {
        category_id: null,
        category_name: catName,
        category_icon: catIcon,
        total: 0,
        alcohol: 0,
        count: 0,
      };
      cb.total += amount;
      cb.alcohol += alcohol;
      cb.count += 1;
      // Icon kann später durch eine andere Buchung in derselben Kategorie
      // gesetzt werden, falls die erste keinen hatte.
      if (!cb.category_icon && catIcon) cb.category_icon = catIcon;
      byCategory.set(catName, cb);

      const tb = byTrip.get(r.trip_id);
      if (tb) {
        tb.total += amount;
        tb.count += 1;
      }

      const meta = tripMeta.get(r.trip_id);
      if (meta) {
        const year = meta.start_date.slice(0, 4);
        const yb = byYear.get(year);
        if (yb) {
          yb.total += amount;
          yb.count += 1;
        }
      }
    }
  }

  // 3. Purged-Aggregation (DSGVO-gepurgte Trips)
  if (purgedIds.length > 0) {
    const { data: purgedRaw } = await supabase
      .from("trip_statistics")
      .select("trip_id, date, category_name, total_amount, alcohol_amount, count")
      .in("trip_id", purgedIds);

    for (const r of (purgedRaw ?? []) as PurgedRow[]) {
      const amount = Number(r.total_amount);
      const alcohol = Number(r.alcohol_amount ?? 0);
      const c = r.count;
      total += amount;
      count += c;

      const cb = byCategory.get(r.category_name) ?? {
        category_id: null,
        category_name: r.category_name,
        category_icon: null,
        total: 0,
        alcohol: 0,
        count: 0,
      };
      cb.total += amount;
      cb.alcohol += alcohol;
      cb.count += c;
      byCategory.set(r.category_name, cb);

      const tb = byTrip.get(r.trip_id);
      if (tb) {
        tb.total += amount;
        tb.count += c;
      }

      const meta = tripMeta.get(r.trip_id);
      if (meta) {
        const year = meta.start_date.slice(0, 4);
        const yb = byYear.get(year);
        if (yb) {
          yb.total += amount;
          yb.count += c;
        }
      }
    }
  }

  // 4. Output sortieren und filtern.
  const byTripArr = Array.from(byTrip.values())
    .filter((t) => t.total > 0 || t.count > 0)
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
  const byCategoryArr = Array.from(byCategory.values()).sort(
    (a, b) => b.total - a.total,
  );
  const byYearArr = Array.from(byYear.values())
    .filter((y) => y.total > 0 || y.count > 0)
    .sort((a, b) => b.year.localeCompare(a.year));

  const tripCount = byTripArr.length;
  return {
    total,
    count,
    tripCount,
    avgPerTrip: tripCount > 0 ? total / tripCount : 0,
    byCategory: byCategoryArr,
    byTrip: byTripArr,
    byYear: byYearArr,
  };
}
