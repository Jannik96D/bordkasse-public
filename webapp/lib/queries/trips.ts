import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";

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

  const admin = await isAdmin();
  // Admin holt alles per Service-Role, alle anderen via Cookie-Client (RLS).
  const supabase = admin ? createAdminClient() : await createClient();

  const { data, error } = await supabase
    .from("trips")
    .select(
      "id, name, start_date, end_date, ship_name, archived, trip_members(person_id, is_skipper)",
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
    trip_members: { person_id: string; is_skipper: boolean }[];
  };

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
    };
  });
}

export async function getTrip(tripId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();
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
}

export async function getTripMembers(tripId: string): Promise<TripMemberRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trip_members")
    .select(`
      id, person_id, on_board_from, on_board_to, is_alcoholic, is_skipper, note,
      persons!inner(display_name, email, is_alcoholic, auth_user_id)
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
    persons:
      | { display_name: string; email: string | null; is_alcoholic: boolean; auth_user_id: string | null }[]
      | { display_name: string; email: string | null; is_alcoholic: boolean; auth_user_id: string | null };
  };
  return (data as unknown as RawRow[]).map((m) => {
    const p = Array.isArray(m.persons) ? m.persons[0] : m.persons;
    return {
      id: m.id,
      person_id: m.person_id,
      display_name: p.display_name,
      email: p.email,
      on_board_from: m.on_board_from,
      on_board_to: m.on_board_to,
      is_alcoholic_override: m.is_alcoholic,
      is_alcoholic_effective: m.is_alcoholic ?? p.is_alcoholic,
      is_skipper: m.is_skipper,
      is_ghost: p.auth_user_id == null,
      note: m.note,
    };
  });
}

export interface CategoryRow {
  id: string;
  name: string;
  hint: string | null;
  icon: string | null;
  sort_order: number;
}

export async function getCategories(tripId: string): Promise<CategoryRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("trip_categories")
    .select("id, name, hint, icon, sort_order")
    .eq("trip_id", tripId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  return data ?? [];
}
