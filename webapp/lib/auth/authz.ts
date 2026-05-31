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

/**
 * Whitelist-Check für die Login-Page: dürfen wir für diese E-Mail
 * überhaupt einen Magic-Link verschicken?
 *
 * Erlaubt sind:
 *   1. E-Mails in der ADMIN_EMAILS-Env (Skipper / Operatoren)
 *   2. E-Mails, die schon mal eingeladen wurden — d.h. eine Row in
 *      persons_private hat (von inviteMember oder createTrip mit
 *      skipper_email angelegt)
 *
 * Damit verhindern wir, dass Fremde durch Magic-Link-Anforderung
 * auth.users-Rows produzieren, die niemand sieht und nirgendwo zugeordnet
 * sind. CITEXT-Spalte sorgt für case-insensitive Vergleich.
 */
export async function isEmailAllowedToSignIn(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  if (getAdminEmails().includes(normalized)) return true;

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("persons_private")
    .select("person_id")
    .ilike("email", normalized)
    .maybeSingle();
  return !!data;
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

/**
 * Eingeloggt UND Skipper (oder Co-Skipper) dieses Trips.
 *
 * Skipper-Status kommt aus trip_members.is_skipper — der Original-Owner
 * (trips.skipper_id) hat dort nach Migration 0008 ebenfalls is_skipper=TRUE.
 */
export async function requireSkipper(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from("trip_members")
    .select("is_skipper")
    .eq("trip_id", tripId)
    .eq("person_id", auth.personId)
    .maybeSingle();
  if (!member) return { ok: false, message: "Du bist nicht Mitglied dieses Törns." };
  if (!member.is_skipper) {
    return { ok: false, message: "Nur Skipper dürfen das ändern." };
  }
  return auth;
}

/**
 * Eingeloggt UND (Skipper dieses Trips ODER globaler Admin via ADMIN_EMAILS).
 * Wird für Power-Operationen genutzt, die ein Admin auch ohne Trip-Mitgliedschaft
 * können soll (z. B. fremde Trips löschen, Schäden beheben).
 */
export async function requireSkipperOrAdmin(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  if (await isAdmin()) return auth;
  return requireSkipper(tripId);
}

/**
 * Eingeloggt UND (Skipper ODER Admin ODER Vorstrecker des Anzahlungs-Plans
 * dieses Trips).
 *
 * Use-Case: der Skipper-Original ist nicht zwingend derselbe wie der, der
 * die Yachtanzahlung vorstreckt. Wenn z.B. Lucas das Geld vorstreckt
 * und Jannik der Trip-Skipper ist, darf Lucas seine eigenen eingehenden
 * Crew-Anzahlungen ankreuzen und Selbstmeldungen bestätigen/ablehnen.
 */
export async function requireSkipperAdminOrAdvancer(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  if (await isAdmin()) return auth;

  const supabase = createAdminClient();
  const [{ data: member }, { data: trip }, { data: plan }] = await Promise.all([
    supabase.from("trip_members").select("is_skipper").eq("trip_id", tripId).eq("person_id", auth.personId).maybeSingle(),
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase.from("prepayment_plan").select("advancer_person_id").eq("trip_id", tripId).maybeSingle(),
  ]);
  if (member?.is_skipper) return auth;
  const advancerId = plan?.advancer_person_id || trip?.skipper_id;
  if (advancerId && advancerId === auth.personId) return auth;
  return {
    ok: false,
    message: "Nur Skipper, Admin oder der Vorstrecker der Anzahlung dürfen das.",
  };
}

/** Eingeloggt UND Crewmitglied dieses Trips (Skipper-Flag egal). */
export async function requireMember(tripId: string): Promise<AuthzResult> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from("trip_members")
    .select("person_id")
    .eq("trip_id", tripId)
    .eq("person_id", auth.personId)
    .maybeSingle();
  if (!member) return { ok: false, message: "Du bist nicht Mitglied dieses Törns." };
  return auth;
}
