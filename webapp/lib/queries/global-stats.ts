import { readClient } from "@/lib/supabase/read-client";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import {
  categoryKey,
  NONE_NAME,
  type GlobalRow,
  type GlobalTripMeta,
} from "@/lib/calc/stats-filter";
import { fetchAllRows } from "@/lib/queries/paginate";

/**
 * Rohdaten der Gesamtstatistik. Auswahl, Summen, „Nach Törn/Jahr",
 * Törn-Anzahl und Ø pro Törn werden im Client aus `rows` abgeleitet
 * (`applyGlobalFilter`).
 */
export type GlobalStatsData = {
  trips: GlobalTripMeta[];
  rows: GlobalRow[];
};

const EMPTY: GlobalStatsData = { trips: [], rows: [] };

type LiveTxRow = {
  id: string;
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

const isPureAlcohol = (amount: number, alcohol: number) => amount - alcohol < 0.005;

/**
 * Lädt Ausgaben über ALLE Törns, die der eingeloggte User sehen darf:
 *   - Reguläre User: Törns, in denen sie Crew sind oder waren (Letzteres via
 *     RLS-Audience-Policy für gepurgte Törns, siehe Migration 0020).
 *   - Admins: alle Törns (Service-Role-Bypass über `readClient()`).
 *
 * Datenquelle gemischt: aktive Törns live aus `transactions`
 * (type=expense, deleted_at IS NULL), gepurgte aus `trip_statistics`.
 * Nur Segeltörns — „Andere Reisen" (trip_type='other') bleiben bewusst
 * draußen (Filter greift auch für gepurgte Törns, die trips-Zeile bleibt).
 *
 * Die Zeilen sind serverseitig nach (Törn, Kategorie-Name) vorverdichtet
 * (klein genug für den Client); die Rohabfragen sind wegen des
 * PostgREST-Limits von 1000 Zeilen paginiert. Reine Alkohol-Buchungen
 * werden dabei je (Törn, Tag, Kategorie) in `pureAlcoholCount` mitgezählt,
 * damit „Alkoholanteil herausrechnen" die Buchungszahl exakt korrigiert.
 */
export async function getGlobalStats(): Promise<GlobalStatsData> {
  const person = await getCurrentPerson();
  if (!person) return EMPTY;

  const supabase = await readClient();

  const { data: tripsRaw } = await supabase
    .from("trips")
    .select("id, name, start_date, end_date, retention_purged_at")
    .eq("trip_type", "sailing")
    .order("start_date", { ascending: false });

  const tripsDb = (tripsRaw ?? []) as Array<{
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    retention_purged_at: string | null;
  }>;
  if (tripsDb.length === 0) return EMPTY;

  const trips: GlobalTripMeta[] = tripsDb.map((t) => ({
    trip_id: t.id,
    name: t.name,
    start_date: t.start_date,
    end_date: t.end_date,
    purged: !!t.retention_purged_at,
  }));
  const year = new Map(tripsDb.map((t) => [t.id, t.start_date.slice(0, 4)]));
  const liveIds = tripsDb.filter((t) => !t.retention_purged_at).map((t) => t.id);
  const purgedIds = tripsDb.filter((t) => t.retention_purged_at).map((t) => t.id);

  // Zwischenstufe (Törn, Tag, Kategorie), um reine Alkohol-Gruppen zu erkennen.
  type Day = { trip_id: string; key: string; name: string; icon: string | null; total: number; alcohol: number; count: number; pure: number };
  const days = new Map<string, Day>();
  const dayOf = (trip_id: string, date: string, key: string, name: string, icon: string | null) => {
    const k = `${trip_id}|${date}|${key}`;
    let d = days.get(k);
    if (!d) {
      d = { trip_id, key, name, icon, total: 0, alcohol: 0, count: 0, pure: 0 };
      days.set(k, d);
    }
    if (!d.icon && icon) d.icon = icon;
    return d;
  };

  if (liveIds.length > 0) {
    const live = await fetchAllRows<LiveTxRow>((from, to) =>
      supabase
        .from("transactions")
        .select(`id, trip_id, date, amount, alcohol_amount, category:trip_categories(name, icon)`)
        .in("trip_id", liveIds)
        .eq("type", "expense")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: LiveTxRow[] | null; error: unknown }>,
    );
    for (const r of live ?? []) {
      const amount = Number(r.amount);
      const alcohol = Number(r.alcohol_amount ?? 0);
      const cat = first(r.category);
      const name = cat?.name?.trim() || NONE_NAME;
      const d = dayOf(r.trip_id, r.date, categoryKey(name), name, cat?.icon ?? null);
      d.total += amount;
      d.alcohol += alcohol;
      d.count += 1;
      if (isPureAlcohol(amount, alcohol)) d.pure += 1;
    }
  }

  if (purgedIds.length > 0) {
    const purged = await fetchAllRows<PurgedRow>((from, to) =>
      supabase
        .from("trip_statistics")
        .select("trip_id, date, category_name, total_amount, alcohol_amount, count")
        .in("trip_id", purgedIds)
        .order("trip_id", { ascending: true })
        .order("date", { ascending: true })
        .order("category_name", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: PurgedRow[] | null; error: unknown }>,
    );
    for (const r of purged ?? []) {
      const name = r.category_name?.trim() || NONE_NAME;
      const d = dayOf(r.trip_id, r.date, categoryKey(name), name, null);
      d.total += Number(r.total_amount);
      d.alcohol += Number(r.alcohol_amount ?? 0);
      d.count += r.count;
    }
  }

  // (Törn, Tag, Kategorie) → (Törn, Kategorie)
  const out = new Map<string, GlobalRow>();
  for (const d of days.values()) {
    const pureAll = d.total - d.alcohol < 0.005;
    const k = `${d.trip_id}|${d.key}`;
    const row = out.get(k) ?? {
      trip_id: d.trip_id,
      year: year.get(d.trip_id) ?? "",
      key: d.key,
      name: d.name,
      icon: d.icon,
      total: 0,
      alcohol: 0,
      count: 0,
      pureAlcoholCount: 0,
    };
    row.total += d.total;
    row.alcohol += d.alcohol;
    row.count += d.count;
    // Bei gepurgten Gruppen nur auf Tagesebene erkennbar: ganze Gruppe rein
    // alkoholisch → alle ihre Buchungen zählen als rein alkoholisch.
    row.pureAlcoholCount = (row.pureAlcoholCount ?? 0) + (d.pure > 0 ? d.pure : pureAll ? d.count : 0);
    if (!row.icon && d.icon) row.icon = d.icon;
    out.set(k, row);
  }

  return { trips, rows: Array.from(out.values()) };
}
