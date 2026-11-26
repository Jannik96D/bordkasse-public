"use server";

import { createHmac } from "node:crypto";
import { z } from "zod";
import { headers } from "next/headers";
import { createCookielessClient } from "@/lib/supabase/cookieless";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEmailAllowedToSignIn } from "@/lib/auth/authz";
import { ensureAuthUser } from "@/lib/auth/ensure-auth-user";
import { resolveOrigin } from "@/lib/auth/origin";
import { resolveClientIp } from "@/lib/auth/client-ip";

const LoginSchema = z.object({
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben."),
});

// Rate-Limit für Magic-Link-Anforderungen (Postgres-gestützt, siehe Migration
// 0036). E-Mail strikt — eine Person braucht selten >3 Links in 15 Min. IP
// großzügig — eine ganze Crew kann am Törn-Start über dasselbe Boots-WLAN/NAT
// kommen und darf sich nicht gegenseitig aussperren.
const RL_WINDOW_SECONDS = 15 * 60;
const RL_MAX_PER_EMAIL = 3;
const RL_MAX_PER_IP = 20;

/**
 * Zählt einen Login-Versuch für E-Mail UND IP und meldet, ob er erlaubt ist.
 * Fail-open: hakt die DB, lassen wir den Login durch — der Limiter ist ein
 * Schutznetz, kein Auth-Gate (die Whitelist schützt weiterhin).
 */
async function withinRateLimit(emailKey: string, ip: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const [emailRes, ipRes] = await Promise.all([
      admin.rpc("bump_login_rate_limit", {
        p_key: `email:${emailKey}`,
        p_max: RL_MAX_PER_EMAIL,
        p_window_seconds: RL_WINDOW_SECONDS,
      }),
      admin.rpc("bump_login_rate_limit", {
        p_key: `ip:${ip}`,
        p_max: RL_MAX_PER_IP,
        p_window_seconds: RL_WINDOW_SECONDS,
      }),
    ]);
    if (emailRes.error || ipRes.error) {
      console.error(
        "[bordkasse:ratelimit]",
        emailRes.error?.message ?? ipRes.error?.message,
      );
      return true; // fail-open
    }
    return emailRes.data !== false && ipRes.data !== false;
  } catch (e) {
    console.error("[bordkasse:ratelimit]", e instanceof Error ? e.message : "unbekannt");
    return true; // fail-open
  }
}

/**
 * Pseudonym einer E-Mail fürs Log: HMAC-SHA256 mit einem serverseitigen
 * Secret, gekürzt auf 12 Hex-Zeichen. Ein ungesalzener Hash ließe sich für
 * die kleine Menge bekannter Crew-Adressen per Wörterbuch zurückrechnen.
 * Schlüssel ist der ohnehin verpflichtende SUPABASE_SERVICE_ROLE_KEY (kein
 * neues Env; der Schlüssel selbst verlässt den Prozess nicht). Fehlt er,
 * wird gar nichts zur Adresse geloggt.
 */
function emailPseudonym(email: string): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex").slice(0, 12);
}

const SEND_FAILED_MESSAGE =
  "Login-Link konnte nicht versandt werden. Bitte später erneut versuchen.";

export type LoginState =
  | { status: "idle" }
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

export async function signInWithMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe.",
    };
  }

  const hdrs = await headers();
  const ip = resolveClientIp(hdrs);

  // Rate-Limit VOR Whitelist + Mailversand — schützt beide Ressourcen
  // (DB-Lookup + Supabase-Auth-Mail) gegen Flutung. Schlüssel klein­geschrieben,
  // damit Groß-/Kleinschreibung der E-Mail das Limit nicht umgeht.
  //
  // Oracle-Schutz: bei Überschreitung geben wir denselben neutralen
  // Erfolgs-Zustand zurück wie bei tatsächlichem Mailversand — ein Angreifer,
  // der E-Mails durchprobiert, soll am Antwortverhalten nicht erkennen können,
  // wann er das Limit trifft. Kein Mailversand, aber intern sichtbar geloggt.
  if (!(await withinRateLimit(parsed.data.email.toLowerCase(), ip))) {
    // E-Mail nur pseudonymisiert (keine PII im Log, Zuordnung gleicher
    // Adressen bleibt möglich). Die IP bleibt im Klartext: sie ist der Wert,
    // dessen Ermittlung vor dem Prod-Deploy einen Tag lang geprüft werden
    // soll (Sanierungsplan 2026-09, PR 8).
    console.warn("[bordkasse:ratelimit] Login-Anfrage rate-limitiert", {
      emailHash: emailPseudonym(parsed.data.email),
      ip,
    });
    return { status: "ok", email: parsed.data.email };
  }

  // Nur E-Mails zulassen, die als Admin in ADMIN_EMAILS oder als Crew-
  // Mitglied (persons_private aus inviteMember / createTrip) hinterlegt
  // sind. Verhindert, dass Fremde via Magic-Link-Anforderung auth.users-
  // Rows produzieren, die niemand sieht und nirgendwo zugeordnet sind.
  const allowed = await isEmailAllowedToSignIn(parsed.data.email);
  if (!allowed) {
    return {
      status: "error",
      message:
        "Diese E-Mail-Adresse ist nicht für die Bordkasse hinterlegt. Bitte deinen Skipper, dich einzuladen.",
    };
  }

  const origin = resolveOrigin(hdrs.get("origin"));
  const supabase = createCookielessClient();
  if (!supabase) {
    console.error("[bordkasse:auth] Supabase-Config fehlt");
    return { status: "error", message: SEND_FAILED_MESSAGE };
  }

  // Sicherheitsrunde 2026-11, Slice 1: das Auth-Konto entsteht NUR hier
  // (bzw. bei der Einladung) serverseitig — bestätigt und mit Anker in
  // `app_metadata`, den `getCurrentPerson` für die Ghost-Verknüpfung
  // verlangt. Fail-closed: ohne Konto keine Mail. Die Meldung ist bewusst
  // dieselbe wie bei einem Versandfehler (keine Rückschlüsse auf Konten).
  const ensured = await ensureAuthUser(parsed.data.email);
  if (!ensured.ok) {
    return { status: "error", message: SEND_FAILED_MESSAGE };
  }

  // Cookieloser Client: die Session entsteht erst in /auth/verify.
  // `shouldCreateUser: false` — Konten legt ausschließlich ensureAuthUser an.
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: false,
    },
  });

  if (error) {
    // Nur der Code, kein GoTrue-Rohtext (der kann die Adresse enthalten).
    console.error("[bordkasse:auth] OTP-Versand fehlgeschlagen:", error.code ?? "unknown");
    return { status: "error", message: SEND_FAILED_MESSAGE };
  }

  return { status: "ok", email: parsed.data.email };
}
