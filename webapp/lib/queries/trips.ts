import { readClient } from "@/lib/supabase/read-client";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

export interface TripListRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  ship_name: string | null;
  archived: boolean;
  is_skipper: boolean;
  is_member: boolean;
  member_count: number;
  /** ISO-Timestamp. Wenn gesetzt, ist der Trip schon gepurged (Statistik bleibt). */
  retention_purged_at: string | null;
  /** Wenn true: Törnende liegt > 30 Tage zurück, aber Daten sind noch nicht gelöscht. */
  retention_overdue: boolean;
  /** Segeltörn (Default) vs. „Andere Reise" — steuert Wording in der Liste. */
  trip_type: "sailing" | "other";
}

/**
 * Liefert Trips für die Übersicht.
 * - Normaler User: nur Trips, in denen er Mitglied ist (RLS erledigt das).
 * - Admin: ALLE Trips (Service-Role-Bypass), mit `is_member`-Flag, ob
 *   er selbst drin steht.
 */
export async function listMyTrips(): Promise<TripListRow[]> {
  const person = await getCurrentPerson();
  if (!person) return [];

  // Admin holt alles per Service-Role (siehe readClient), alle anderen via
  // Cookie-Client (RLS-gefiltert auf eigene Trips).
  const supabase = await readClient();

  const { data, error } = await supabase
    .from("trips")
    .select(
      "id, name, start_date, end_date, ship_name, archived, retention_purged_at, trip_type, trip_members(person_id, is_skipper)",
    )
    .order("start_date", { ascending: false });

  if (error || !data) return [];

  type Raw = {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    ship_name: string | null;
    archived: boolean;
    retention_purged_at: string | null;
    trip_type: string | null;
    trip_members: { person_id: string; is_skipper: boolean }[];
  };

  // 30 Tage in der Vergangenheit als ISO-Datum für den Vergleich.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  return (data as unknown as Raw[]).map((t) => {
    const myMembership = t.trip_members.find((m) => m.person_id === person.id);
    return {
      id: t.id,
      name: t.name,
      start_date: t.start_date,
      end_date: t.end_date,
      ship_name: t.ship_name,
      archived: t.archived,
      is_skipper: myMembership?.is_skipper ?? false,
      is_member: !!myMembership,
      member_count: t.trip_members.length,
      retention_purged_at: t.retention_purged_at,
      retention_overdue: !t.retention_purged_at && t.end_date < cutoffIso,
      trip_type: t.trip_type === "other" ? "other" : "sailing",
    };
  });
}

export async function getTrip(tripId: string) {
  const supabase = await readClient();
  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();
  // Echten DB-/Netzfehler von "Törn existiert nicht / kein Zugriff" trennen:
  // Bei einem Fehler werfen → die Error-Boundary (app/error.tsx) greift.
  // Nur data=null OHNE Fehler bedeutet wirklich "nicht gefunden" und führt im
  // Layout zu notFound() — sonst würde ein transienter DB-Fehler fälschlich
  // als "Törn nicht gefunden" angezeigt.
  if (error) {
    throw new Error(`[bordkasse:getTrip] ${error.message}`);
  }
  return data;
}

export interface TripMemberRow {
  id: string;
  person_id: string;
  display_name: string;
  email: string | null;
  on_board_from: string | null;
  on_board_to: string | null;
  is_alcoholic_override: boolean | null;
  is_alcoholic_effective: boolean;
  is_skipper: boolean;
  is_ghost: boolean; // person hat noch keinen auth_user_id — Skipper darf Email/Namen ändern
  note: string | null;
  /** Wann dieses Mitglied die Törn-Fortschritt-Karte minimiert hat (NULL = offen). */
  checklist_collapsed_at: string | null;
}

export async function getTripMembers(tripId: string): Promise<TripMemberRow[]> {
  const supabase = await readClient();
  // Members + öffentlicher persons-Teil (RLS: nur Crew-Kollegen sichtbar)
  const { data, error } = await supabase
    .from("trip_members")
    .select(`
      id, person_id, on_board_from, on_board_to, is_alcoholic, is_skipper, note, checklist_collapsed_at,
      persons!inner(display_name, is_alcoholic, auth_user_id)
    `)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  type RawRow = {
    id: string;
    person_id: string;
    on_board_from: string | null;
    on_board_to: string | null;
    is_alcoholic: boolean | null;
    is_skipper: boolean;
    note: string | null;
    checklist_collapsed_at: string | null;
    persons:
      | { display_name: string; is_alcoholic: boolean; auth_user_id: string | null }[]
      | { display_name: string; is_alcoholic: boolean; auth_user_id: string | null };
  };
  const rows = (data as unknown as RawRow[]).map((m) => {
    const p = Array.isArray(m.persons) ? m.persons[0] : m.persons;
    return {
      id: m.id,
      person_id: m.person_id,
      display_name: p.display_name,
      email: null as string | null,
      on_board_from: m.on_board_from,
      on_board_to: m.on_board_to,
      is_alcoholic_override: m.is_alcoholic,
      is_alcoholic_effective: m.is_alcoholic ?? p.is_alcoholic,
      is_skipper: m.is_skipper,
      is_ghost: p.auth_user_id == null,
      note: m.note,
      checklist_collapsed_at: m.checklist_collapsed_at,
    };
  });

  // E-Mails separat aus persons_private holen — RLS liefert nur die,
  // die der Caller sehen darf (Self oder Trip-Skipper). Bei Crewmitgliedern
  // ohne Sichtbarkeit bleibt email = null, was die UI als „nicht zeigen"
  // interpretieren kann.
  const personIds = rows.map((r) => r.person_id);
  if (personIds.length > 0) {
    const { data: privs } = await supabase
      .from("persons_private")
      .select("person_id, email")
      .in("person_id", personIds);
    const emailById = new Map<string, string | null>();
    for (const p of privs ?? []) emailById.set(p.person_id, p.email);
    for (const r of rows) {
      r.email = emailById.get(r.person_id) ?? null;
    }
  }

  return rows;
}

export interface CategoryRow {
  id: string;
  name: string;
  hint: string | null;
  icon: string | null;
  sort_order: number;
}

export async function getCategories(tripId: string): Promise<CategoryRow[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("trip_categories")
    .select("id, name, hint, icon, sort_order")
    .eq("trip_id", tripId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  return data ?? [];
}
