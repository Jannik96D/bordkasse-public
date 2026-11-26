import "server-only";
import { createCookielessClient } from "@/lib/supabase/cookieless";
import { ensureAuthUser } from "@/lib/auth/ensure-auth-user";

/**
 * Schickt einer eingeladenen Person die gebrandete Magic-Link-Mail.
 *
 * Aufrufer: `inviteMember` + `updateMember` (erste E-Mail eines Ghosts) in
 * lib/actions/trip-members.ts und `replaceMember` in lib/actions/prepayments.ts.
 *
 * Sicherheitsrunde 2026-11, Slice 1: das Auth-Konto wird VOR dem Versand
 * serverseitig über `ensureAuthUser` angelegt (bestätigt, mit Anker in
 * `app_metadata`), der OTP-Versand selbst legt mit `shouldCreateUser: false`
 * kein Konto mehr an. Damit funktioniert die Einladung auch bei
 * abgeschaltetem GoTrue-Signup (Slice 2).
 *
 * Der Versand läuft über einen cookielosen anon-Client — sonst würde die
 * Skipper-Session des Aufrufers berührt. Der Empfänger klickt →
 * /auth/confirm → /auth/verify → eingeloggt; `getCurrentPerson` verlinkt
 * die Ghost-Person, weil der Anker zur Adresse passt.
 *
 * Returns { ok: false } wenn Kontoanlage oder Versand scheitert, blockt
 * aber nicht die eigentliche Crew-Einladung (Skipper-Workflow bleibt
 * funktional, selbst wenn die Mail-Zustellung kurzzeitig hängt).
 */
export async function sendInvitationMagicLink(
  email: string,
  origin: string,
): Promise<{ ok: boolean; message?: string }> {
  // Defense-in-depth: ohne gültigen Origin würde `emailRedirectTo` auf eine
  // kaputte URL zeigen — dann lieber sauber abbrechen statt eine unbrauchbare
  // Mail zu verschicken.
  if (!origin) {
    return { ok: false, message: "Kein gültiger App-Origin — Mail nicht verschickt." };
  }
  const client = createCookielessClient();
  if (!client) {
    return { ok: false, message: "Supabase-Config fehlt — Mail nicht verschickt." };
  }

  // Konto zuerst (fail-closed): ohne Konto + Anker würde der Link mit
  // `shouldCreateUser: false` ohnehin nicht zugestellt bzw. die Ghost-Person
  // beim Klick nicht verknüpft.
  const ensured = await ensureAuthUser(email);
  if (!ensured.ok) {
    return { ok: false, message: `Konto konnte nicht vorbereitet werden (${ensured.code}).` };
  }

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      // Konten legt ausschließlich ensureAuthUser an (mit Anker).
      shouldCreateUser: false,
    },
  });

  if (error) {
    // Empfänger-Mail bewusst NICHT loggen (keine PII in die Container-Logs).
    console.error("[bordkasse:invite] Einladungs-Mail fehlgeschlagen:", error.code ?? "unknown");
    return { ok: false, message: error.code ?? "Versand fehlgeschlagen." };
  }
  return { ok: true };
}
