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
 * kurzlebiges Cookie mit `<ts>.<HMAC(normalisierte Adresse|ts)>`. /auth/verify
 * löst den Token ein und verlangt, dass dieses Cookie zur Adresse des
 * Token-INHABERS passt. Ein untergeschobener Angreifer-Link besteht das nicht:
 * der Browser des Opfers trägt kein Cookie für die Adresse des Angreifers.
 *
 * - Keine Klartext-Adresse im Cookie, nur Zeitstempel + HMAC.
 * - Der Zeitstempel wird serverseitig auf 60 Min geprüft (nicht nur Max-Age,
 *   das ein Client/Angreifer nicht respektieren muss).
 * - Cookie-Tossing: eine Subdomain könnte ein gleichnamiges Cookie für die
 *   ganze Domain setzen. In Production deshalb `__Host-`-Präfix (Secure,
 *   Path=/, kein Domain-Attribut → nur der exakte Host kann es setzen). Ein
 *   getossztes Cookie müsste außerdem einen gültigen HMAC tragen — ohne das
 *   Secret nicht fälschbar; das Präfix verhindert, dass ein Angreifer ein
 *   ECHTES Cookie des Opfers (z. B. ein vorher mitgeschnittenes) einschleust
 *   bzw. das echte überschreibt.
 *
 * Schlüssel: aus SUPABASE_SERVICE_ROLE_KEY abgeleitet (Runtime-only-Secret,
 * serverseitig, ohnehin Pflicht, stabil) — kein neues Pflicht-Env. Eine
 * Rotation entwertet nur offene Cookies, dann greift der Fallback.
 */
export const LOGIN_INTENT_MAX_AGE_SECONDS = 60 * 60;
/** `__Host-` verlangt Path=/. */
export const LOGIN_INTENT_PATH = "/";
/** Toleranz für Uhrenabweichung bei Zeitstempeln „aus der Zukunft". */
const FUTURE_SKEW_SECONDS = 60;

/** Cookie-Name: `__Host-`-Präfix nur in Production (dort ist Secure/HTTPS garantiert). */
export function loginIntentCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-bk_login_intent" : "bk_login_intent";
}

function key(): Buffer | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  // Domain-Separation: der Rohschlüssel selbst wird nie als HMAC-Key genutzt.
  return createHmac("sha256", secret).update("bordkasse:login-intent:v1").digest();
}

function mac(k: Buffer, email: string, ts: number): string {
  return createHmac("sha256", k).update(`${normalizeEmail(email)}|${ts}`).digest("hex");
}

/** Cookie-Wert `<ts>.<hmac>`; `null`, wenn kein Secret vorhanden ist. */
export function loginIntentValue(email: string, nowMs: number = Date.now()): string | null {
  const k = key();
  if (!k) return null;
  const ts = Math.floor(nowMs / 1000);
  return `${ts}.${mac(k, email, ts)}`;
}

/** Konstant-zeitiger Vergleich inkl. serverseitiger Altersprüfung (60 Min). */
export function loginIntentMatches(
  email: string | undefined,
  cookieValue: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!email || !cookieValue) return false;
  const k = key();
  if (!k) return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(cookieValue);
  if (!m) return false;
  const ts = Number(m[1]);
  const age = Math.floor(nowMs / 1000) - ts;
  if (age > LOGIN_INTENT_MAX_AGE_SECONDS || age < -FUTURE_SKEW_SECONDS) return false;
  const a = Buffer.from(mac(k, email, ts));
  const b = Buffer.from(m[2]);
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
