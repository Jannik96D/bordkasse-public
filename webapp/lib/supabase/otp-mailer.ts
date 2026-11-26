import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Cookieloser Client mit **Service-Role-Key** für den Magic-Link-Versand
 * (`signInWithOtp` in der Login-Action und in `sendInvitationMagicLink`).
 *
 * Sicherheitsrunde 2026-11, Slice 2: Kong lässt den anon-Key auf `/auth/v1/`
 * nur noch an eine Allowlist (Token-Refresh, `GET /user`, `POST /logout`,
 * die offenen Routen) — `/otp` ist für anon gesperrt, damit niemand mit dem
 * öffentlichen Key aus dem Browser-Bundle Mails auslösen und das globale
 * GoTrue-Mail-Kontingent erschöpfen kann. Den Versand darf deshalb nur noch
 * der admin-Consumer (Service-Role-Key) anstoßen; davor laufen in der App
 * Rate-Limit, Whitelist und `ensureAuthUser`.
 *
 * ⚠️ Der Client umgeht RLS (Service-Role). Er ist AUSSCHLIESSLICH für den
 * OTP-Versand gedacht — nicht für Lese- oder Schreib-Queries verwenden (dafür
 * `readClient()` bzw. `createAdminClient()` nach geprüfter Autorisierung).
 *
 * Cookielos, weil der Versand keine Session braucht (die entsteht erst in
 * `/auth/verify`); ein Cookie-Client würde beim Einladen sonst die Session
 * des Skippers berühren. Liefert `null`, wenn die Config fehlt — die Aufrufer
 * melden dann einen Versandfehler (fail-closed, bewusst KEIN Rückfall auf den
 * anon-Key, der nach der Kong-Sperre ohnehin mit 403 scheitert).
 */
export function createOtpMailerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
