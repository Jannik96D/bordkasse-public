import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Sicherheitsrunde 2026-11, Slice 1 — Konten entstehen nur noch serverseitig.
 *
 * Vorher legte `signInWithOtp` (Login + Einladung) das Auth-Konto als
 * Nebenwirkung an, und `getCurrentPerson` verknüpfte JEDE Session allein
 * über `user.email` mit einer Ghost-Person. `user.email` ist aber über
 * GoTrue änderbar (`PUT /auth/v1/user`, mit Autoconfirm ohne Bestätigung),
 * und Konten lassen sich per offenem `POST /auth/v1/signup` mit fremder
 * Adresse anlegen — ein beliebiges Konto konnte sich so eine fremde
 * Ghost-Identität holen.
 *
 * Deshalb trägt jedes Konto, das die App selbst anlegt oder für den Login
 * vorbereitet, einen **Anker** in `app_metadata.bordkasse_email`.
 * `app_metadata` kann nur der Service-Role-Key schreiben, nie der Nutzer
 * selbst. `getCurrentPerson` verknüpft eine Ghost-Person nur noch, wenn der
 * Anker zur aktuellen `user.email` passt.
 *
 * Ablauf:
 *   1. `admin.createUser({ email_confirm: true, app_metadata: { Anker } })`.
 *   2. Fehlercode `email_exists` (über `error.code`, nie über den Text) →
 *      Bestandskonto suchen und nach seinem Zustand behandeln:
 *      - Anker passt: ggf. bestätigen, sonst nichts schreiben.
 *      - Anker für eine ANDERE Adresse: das Konto hat seine E-Mail per
 *        `PUT /auth/v1/user` geändert (die App ändert Konto-Adressen nie)
 *        und belegt damit fremde Adressen. Es bekommt seine Anker-Adresse
 *        zurück (oder wird geparkt, siehe `displaceAccount`), danach wird für
 *        die angefragte Adresse neu angelegt.
 *      - Kein Anker, aber per `persons.auth_user_id` mit einer Person
 *        verknüpft, deren `persons_private.email` die Adresse ist:
 *        legitimes Altkonto → bestätigen + ankern.
 *      - Kein Anker und keine Verknüpfung: nicht unterscheidbar zwischen
 *        „eingeladen, Link nie benutzt" und „am App-Login vorbei per Signup
 *        angelegt". Das Konto trägt keine App-Daten, deshalb wird es
 *        gelöscht und frisch angelegt — dabei verfallen ein evtl. gesetztes
 *        Passwort und alle Sessions. Würde es stattdessen geankert, könnte
 *        sich ein Angreifer den Anker durch Absenden des Login-Formulars mit
 *        der Opfer-Adresse selbst verschaffen (Grill-Fund B1).
 *      - Verknüpft, aber mit ABWEICHENDER Personen-Adresse (Altkonto ohne
 *        Anker hat die Adresse besetzt): wie „fremder Anker" — zurück auf
 *        die Personen-Adresse (mit Anker) bzw. parken, dann neu anlegen.
 *      - Verknüpft, aber OHNE hinterlegte Personen-Adresse: fail-closed
 *        (rechtmäßige Adresse unbekannt; Parken würde das Konto von seiner
 *        Person trennen).
 *   War die Adresse frei, prüft `restoreDriftedAnchorHolder`, ob ein
 *   App-Konto mit genau diesem Anker seine Adresse weggeändert hat, und holt
 *   es zurück, statt einen personenlosen Zwilling stehen zu lassen.
 *      Bestätigen ist nötig, weil GoTrue `/otp` für ein UNBESTÄTIGTES Konto
 *      wie eine Registrierung behandelt — bei abgeschaltetem Signup
 *      (Slice 2) wäre das Konto sonst ausgesperrt.
 *   3. Jeder andere Fehler → fail-closed. Geloggt wird nur der Fehlercode,
 *      nie die Adresse.
 *
 * Aufrufer: `signInWithMagicLink` (app/login/actions.ts) nach Rate-Limit und
 * Whitelist, `sendInvitationMagicLink` (lib/auth/invite.ts) vor dem
 * OTP-Versand. Beide verschicken den Link danach mit
 * `shouldCreateUser: false`.
 */

export type EnsureAuthUserResult = { ok: true } | { ok: false; code: string };

type Admin = ReturnType<typeof createAdminClient>;
type ExistingUser = { id: string; app_metadata: unknown; email_confirmed_at: string | null };

/** Obergrenze für das seitenweise Durchsuchen der Konten (je 1000). */
const MAX_LIST_PAGES = 50;
const PER_PAGE = 1000;

/** Normalisierter Anker aus `app_metadata` (oder null). */
export function authAnchorOf(appMetadata: unknown): string | null {
  if (!appMetadata || typeof appMetadata !== "object") return null;
  const v = (appMetadata as Record<string, unknown>).bordkasse_email;
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

function fail(stage: string, code: string | undefined): EnsureAuthUserResult {
  const c = code ?? "unknown";
  // Bewusst nur Stufe + Code — keine Adresse, kein GoTrue-Rohtext.
  console.error(`[bordkasse:ensure-auth-user] ${stage} fehlgeschlagen: ${c}`);
  return { ok: false, code: c };
}

async function createAnchored(admin: Admin, email: string) {
  return admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { bordkasse_email: email },
  });
}

/** Sucht das Konto mit genau dieser Adresse (Admin-API kennt keinen E-Mail-Filter). */
async function findUserByEmail(
  admin: Admin,
  email: string,
): Promise<{ user: ExistingUser | null; errorCode?: string }> {
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) return { user: null, errorCode: error.code ?? "unknown" };
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").trim().toLowerCase() === email);
    if (hit) {
      return {
        user: {
          id: hit.id,
          app_metadata: hit.app_metadata,
          email_confirmed_at: hit.email_confirmed_at ?? null,
        },
      };
    }
    if (users.length < PER_PAGE) break;
  }
  return { user: null };
}

/**
 * Ist das Konto per `persons.auth_user_id` mit einer Person verknüpft, und
 * wenn ja, welche Adresse ist für sie hinterlegt? Fehler → `error`.
 */
async function linkState(
  admin: Admin,
  userId: string,
): Promise<{ state: "none" | "linked" | "error"; stored: string | null }> {
  const { data: person, error } = await admin
    .from("persons")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) return { state: "error", stored: null };
  if (!person) return { state: "none", stored: null };
  const { data: priv, error: privErr } = await admin
    .from("persons_private")
    .select("email")
    .eq("person_id", person.id)
    .maybeSingle();
  if (privErr) return { state: "error", stored: null };
  const stored = typeof priv?.email === "string" ? priv.email.trim().toLowerCase() : null;
  return { state: "linked", stored: stored || null };
}

/**
 * Ein Konto besetzt per `PUT /auth/v1/user` eine fremde Adresse (die App
 * ändert Konto-Adressen nie). Es bekommt seine rechtmäßige Adresse zurück
 * (`ownAddress` = Anker bzw. die Adresse seiner verknüpften Person), mit Anker.
 * Ist die schon wieder vergeben (oder unbekannt), wird es auf eine nicht
 * zustellbare Platzhalter-Adresse geparkt — eine verknüpfte Person findet es
 * weiter über `auth_user_id`. Danach ist die angefragte Adresse frei.
 * (Grill-Runde 2, Befunde 1+2: sonst blieb die Adresse dauerhaft blockiert.)
 */
async function displaceAccount(
  admin: Admin,
  userId: string,
  ownAddress: string | null,
): Promise<EnsureAuthUserResult> {
  console.error("[bordkasse:ensure-auth-user] Konto belegt eine fremde Adresse — wird zurückgesetzt");
  if (ownAddress) {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      email: ownAddress,
      email_confirm: true,
      app_metadata: { bordkasse_email: ownAddress },
    });
    if (!error) return { ok: true };
    // Bewusst JEDER Fehler → parken: GoTrue meldet eine schon vergebene
    // Adresse beim Admin-Update nicht als `email_exists`, sondern (lokal
    // v2.195 belegt) als HTTP 500 mit Postgres-Code 23505. Parken ist für das
    // besetzende Konto unschädlich (Verknüpfung bleibt über auth_user_id).
    console.error("[bordkasse:ensure-auth-user] Zurücksetzen fehlgeschlagen, Konto wird geparkt:", error.code ?? "unknown");
  }
  const { error: parkErr } = await admin.auth.admin.updateUserById(userId, {
    email: `displaced+${userId}@bordkasse.invalid`,
    email_confirm: true,
  });
  return parkErr ? fail("anchor-park", parkErr.code) : { ok: true };
}

/**
 * Die Adresse war frei — aber vielleicht nur, weil ein App-Konto mit genau
 * diesem Anker seine Adresse per `PUT /auth/v1/user` woandershin geändert hat.
 * Dann wäre das frisch angelegte Konto ein Zwilling ohne Person (die gehört
 * dem alten Konto), und der Inhaber käme nie wieder an seine Person. In dem
 * Fall: Zwilling löschen, altes Konto auf seine Anker-Adresse zurücksetzen.
 *
 * Bewusst fail-open, wenn die Suche selbst scheitert: für echte Neukonten
 * (der Normalfall) wäre ein Abbruch ein Ausfall, und der Schaden des
 * Sonderfalls trifft nur den Kontoinhaber selbst (Grill-Fund PR #299, 2).
 */
async function restoreDriftedAnchorHolder(
  admin: Admin,
  newUserId: string | null,
  email: string,
): Promise<EnsureAuthUserResult> {
  if (!newUserId) return { ok: true };
  let holder: string | null = null;
  try {
    for (let page = 1; page <= MAX_LIST_PAGES && !holder; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) {
        console.error("[bordkasse:ensure-auth-user] Anker-Suche übersprungen:", error.code ?? "unknown");
        return { ok: true };
      }
      const users = data?.users ?? [];
      const hit = users.find((u) => u.id !== newUserId && authAnchorOf(u.app_metadata) === email);
      if (hit) holder = hit.id;
      if (users.length < PER_PAGE) break;
    }
  } catch {
    // Netzfehler o. Ä. → wie `{ error }` behandeln: fail-open (siehe oben).
    console.error("[bordkasse:ensure-auth-user] Anker-Suche übersprungen: exception");
    return { ok: true };
  }
  if (!holder) return { ok: true };

  console.error("[bordkasse:ensure-auth-user] Konto mit diesem Anker hatte seine Adresse geändert — wird zurückgesetzt");
  // Reihenfolge zwingend: erst den Zwilling löschen, sonst belegt er die
  // Adresse und das Zurücksetzen scheitert an der UNIQUE-Bedingung.
  const { error: delErr } = await admin.auth.admin.deleteUser(newUserId);
  if (delErr) return fail("twin-delete", delErr.code);
  const { error: resetErr } = await admin.auth.admin.updateUserById(holder, {
    email,
    email_confirm: true,
  });
  return resetErr ? fail("anchor-restore", resetErr.code) : { ok: true };
}

/** Neu anlegen (mit Anker) und danach auf einen Anker-Zwilling prüfen. */
async function createAndRestore(admin: Admin, email: string, stage: string): Promise<EnsureAuthUserResult> {
  const { data, error } = await createAnchored(admin, email);
  if (error) return fail(stage, error.code);
  return restoreDriftedAnchorHolder(admin, data?.user?.id ?? null, email);
}

export async function ensureAuthUser(rawEmail: string): Promise<EnsureAuthUserResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { ok: false, code: "empty_email" };

  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return fail("admin-client", "config_missing");
  }

  const { data: created, error: createErr } = await createAnchored(admin, email);
  if (!createErr) return restoreDriftedAnchorHolder(admin, created?.user?.id ?? null, email);
  if (createErr.code !== "email_exists") return fail("createUser", createErr.code);

  const found = await findUserByEmail(admin, email);
  if (found.errorCode) return fail("listUsers", found.errorCode);
  const existing = found.user;
  if (!existing) return fail("lookup", "user_not_found");

  const anchor = authAnchorOf(existing.app_metadata);

  // Anker passt: nur noch bestätigen, falls nötig (kein Schreibzugriff pro Login).
  if (anchor === email) {
    if (existing.email_confirmed_at) return { ok: true };
    const { error } = await admin.auth.admin.updateUserById(existing.id, { email_confirm: true });
    return error ? fail("updateUserById", error.code) : { ok: true };
  }

  // Anker für eine andere Adresse: Konto hat die angefragte Adresse per
  // PUT /auth/v1/user besetzt → zurücksetzen bzw. parken, dann neu anlegen.
  if (anchor) {
    const displaced = await displaceAccount(admin, existing.id, anchor);
    if (!displaced.ok) return displaced;
    return createAndRestore(admin, email, "createUser-nach-reset");
  }

  const link = await linkState(admin, existing.id);
  if (link.state === "error") return fail("link-lookup", "db_error");

  if (link.state === "linked") {
    // Verknüpft, aber ohne hinterlegte Personen-Adresse (z. B. ein alter
    // Admin, dessen persons_private-Insert damals scheiterte): wir kennen die
    // rechtmäßige Adresse nicht. Parken würde das Konto beim EIGENEN Login
    // von seiner Person trennen (Schritt 3 legte danach eine zweite an),
    // automatisches Nachtragen hieße, einer womöglich per PUT /auth/v1/user
    // geänderten Adresse zu vertrauen. Deshalb fail-closed: Fall von Hand
    // klären (Backfill-Abfrage A3, Erwartung 0).
    if (link.stored === null) return fail("link-lookup", "linked_without_address");
    // Legitimes Altkonto: Konto-Adresse = Adresse der verknüpften Person.
    if (link.stored === email) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        email_confirm: true,
        app_metadata: { bordkasse_email: email },
      });
      return error ? fail("updateUserById", error.code) : { ok: true };
    }
    // Verknüpftes Altkonto (noch ohne Anker) hat die Adresse besetzt.
    const displaced = await displaceAccount(admin, existing.id, link.stored);
    if (!displaced.ok) return displaced;
    return createAndRestore(admin, email, "createUser-nach-reset");
  }

  // Kein Anker, keine Verknüpfung: löschen und frisch anlegen (siehe Kopf).
  const { error: delErr } = await admin.auth.admin.deleteUser(existing.id);
  if (delErr) return fail("deleteUser", delErr.code);
  return createAndRestore(admin, email, "createUser-nach-delete");
}
