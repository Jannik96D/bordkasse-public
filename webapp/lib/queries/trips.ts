import { createClient } from "@/lib/supabase/server";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

export interface TripListRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  ship_name: string | null;
  archived: boolean;
  is_skipper: boolean;
  member_count: number;
}

/** Liefert alle Trips, in denen der User Skipper oder Mitglied ist. */
export async function listMyTrips(): Promise<TripListRow[]> {
  const person = await getCurrentPerson();
  if (!person) return [];

  const supabase = await createClient();

  // Trips, in denen ich Skipper bin ODER trip_members-Eintrag habe.
  // RLS kümmert sich um die Filterung — wir lesen einfach ALLE sichtbaren
  // Trips und reichen Skipper-Flag durch.
  const { data, error } = await supabase
    .from("trips")
    .select("id, name, start_date, end_date, ship_name, archived, skipper_id, trip_members(count)")
    .order("start_date", { ascending: false });

  if (error || !data) return [];

  return data.map((t) => ({
    id: t.id,
    name: t.name,
    start_date: t.start_date,
    end_date: t.end_date,
    ship_name: t.ship_name,
    archived: t.archived,
    is_skipper: t.skipper_id === person.id,
    member_count: (t.trip_members as { count: number }[])?.[0]?.count ?? 0,
  }));
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
  note: string | null;
}

export async function getTripMembers(tripId: string): Promise<TripMemberRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trip_members")
    .select(`
      id, person_id, on_board_from, on_board_to, is_alcoholic, note,
      persons!inner(display_name, email, is_alcoholic)
    `)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  // Supabase-Type-Inferenz: bei !inner-Relation ist persons ein Array.
  // Wir nehmen den ersten (und einzigen) Eintrag.
  type RawRow = {
    id: string;
    person_id: string;
    on_board_from: string | null;
    on_board_to: string | null;
    is_alcoholic: boolean | null;
    note: string | null;
    persons: { display_name: string; email: string | null; is_alcoholic: boolean }[]
           | { display_name: string; email: string | null; is_alcoholic: boolean };
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
      note: m.note,
    };
  });
}

export interface CategoryRow {
  id: string;
  name: string;
  hint: string | null;
  sort_order: number;
}

export async function getCategories(tripId: string): Promise<CategoryRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("trip_categories")
    .select("id, name, hint, sort_order")
    .eq("trip_id", tripId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  return data ?? [];
}
