import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "@/lib/auth/email-param";

/**
 * „Login-Intent"-Beleg gegen Login-CSRF.
 *
 * Problem: `/auth/confirm?token_hash=<Token des Angreifers>` würde ein Opfer
 * nach einem Klick ins Konto des Angreifers einloggen. Der `email`-Parameter
 * der URL ist fälschbar und taugt nicht als Beleg.
 *
 * Beleg auf Opferseite: wer auf /login einen Link anfordert, bekommt ein
 * kurzlebiges Cookie mit einem HMAC der (normalisierten) Adresse. /auth/verify
 * löst den Token ein und verlangt, dass dieses Cookie zur Adresse des
 * Token-INHABERS passt. Ein untergeschobener Angreifer-Link besteht das nicht:
 * der Browser des Opfers trägt kein Cookie für die Adresse des Angreifers.
 *
 * Das Cookie enthält keine Klartext-Adresse, nur den HMAC. Schlüssel: aus
 * SUPABASE_SERVICE_ROLE_KEY abgeleitet (Runtime-only-Secret, serverseitig,
 * ohnehin Pflicht, stabil) — kein neues Pflicht-Env. Eine Rotation entwertet
 * nur offene Cookies (60 Min), dann greift der Fallback (Adresse eintippen).
 */
export const LOGIN_INTENT_COOKIE = "bk_login_intent";
export const LOGIN_INTENT_MAX_AGE_SECONDS = 60 * 60;
/** Nur Auth-Routen brauchen das Cookie. */
export const LOGIN_INTENT_PATH = "/auth";

function key(): Buffer | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  // Domain-Separation: der Rohschlüssel selbst wird nie als HMAC-Key genutzt.
  return createHmac("sha256", secret).update("bordkasse:login-intent:v1").digest();
}

/** HMAC (hex) der normalisierten Adresse; `null`, wenn kein Secret vorhanden ist. */
export function loginIntentValue(email: string): string | null {
  const k = key();
  if (!k) return null;
  return createHmac("sha256", k).update(normalizeEmail(email)).digest("hex");
}

/** Konstant-zeitiger Vergleich des Cookies mit der erwarteten Adresse. */
export function loginIntentMatches(
  email: string | undefined,
  cookieValue: string | undefined,
): boolean {
  if (!email || !cookieValue) return false;
  const expected = loginIntentValue(email);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(cookieValue);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookie-Optionen: HttpOnly, SameSite=Lax (Mail-Link = Top-Level-GET), Secure in Production. */
export function loginIntentCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: LOGIN_INTENT_PATH,
    maxAge: LOGIN_INTENT_MAX_AGE_SECONDS,
  };
}
