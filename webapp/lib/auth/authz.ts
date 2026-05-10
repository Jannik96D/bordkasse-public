/**
 * Authorization-Helpers für Server Actions.
 *
 * Da wir in Server Actions mit dem Admin-Client schreiben (siehe
 * lib/supabase/admin.ts — Workaround für Auth-Cookie-Propagation in
 * Next.js 16 Server Actions), übernimmt der App-Code die Rolle, die
 * vorher RLS hatte: prüfen, ob der eingeloggte User die Operation darf.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "./get-current-person";

export type AuthzResult =
  | { ok: true; personId: string }
  | { ok: false; message: string };

/** Stellt sicher, dass jemand eingeloggt ist. */
export async function requireAuth(): Promise<AuthzResult> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };
  return { ok: true, personId: person.id };
}

/**
 * Liest die Admin-Allowlist aus der Env-Variable ADMIN_EMAILS.
 * Format: komma-separiert, Leerzeichen werden getrimmt, Vergleich
 * lowercase. Wenn die Variable nicht gesetzt ist, ist niemand Admin
 * (fail-closed → niemand darf Törns anlegen).
 */
export function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdmin(): Promise<boolean> {
  const person = await getCurrentPerson();
  if (!person?.email) return false;
  return getAdminEmails().includes(person.email.toLowerCase());
}

/** Eingeloggt UND in der ADMIN_EMAILS-Allowlist. */
export async function requireAdmin(): Promise<AuthzResult> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };
  if (!person.email || !getAdminEmails().includes(person.email.toLowerCase())) {
    return { ok: false, message: "Nur Admins dürfen Törns anlegen." };
  }
  return { ok: true, personId: person.id };
}

/** Eingeloggt UND Skipper dieses Trips. */
export async function requireSkipper(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  const supabase = createAdminClient();
  const { data: trip } = await supabase
    .from("trips")
    .select("skipper_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  if (trip.skipper_id !== auth.personId) {
    return { ok: false, message: "Nur der Skipper darf das ändern." };
  }
  return auth;
}

/** Eingeloggt UND Crew-Mitglied (oder Skipper) dieses Trips. */
export async function requireMember(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  const supabase = createAdminClient();
  const [{ data: trip }, { data: member }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase
      .from("trip_members")
      .select("person_id")
      .eq("trip_id", tripId)
      .eq("person_id", auth.personId)
      .maybeSingle(),
  ]);
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  if (trip.skipper_id !== auth.personId && !member) {
    return { ok: false, message: "Du bist nicht Mitglied dieses Törns." };
  }
  return auth;
}
