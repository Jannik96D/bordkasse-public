import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Schickt einer eingeladenen Person die gebrandete Magic-Link-Mail.
 *
 * Wird beim Hinzufügen zur Crew aufgerufen (inviteMember). Nutzt einen
 * frischen anon-Client OHNE Cookies — sonst würde die Skipper-Session
 * des Aufrufers durcheinandergeraten (signInWithOtp setzt sonst die
 * Cookie-basierte Session zurück).
 *
 * Supabase versendet automatisch das Magic-Link-Template (gebrandetes
 * HTML aus dem Dashboard). Der Empfänger klickt → /auth/confirm → wird
 * eingeloggt UND die Ghost-Person via get-current-person mit dem neuen
 * auth_user_id verlinkt.
 *
 * Returns { ok: false } wenn der Versand scheitert, blockt aber nicht
 * die eigentliche Crew-Einladung (Skipper-Workflow bleibt funktional
 * selbst wenn die Mail-Zustellung kurzzeitig hängt).
 */
export async function sendInvitationMagicLink(
  email: string,
  origin: string,
): Promise<{ ok: boolean; message?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { ok: false, message: "Supabase-Config fehlt — Mail nicht verschickt." };
  }

  const client = createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      // Bei Erst-Einladung gibt's noch keinen auth.users-Eintrag — Supabase
      // legt ihn an. Bei bereits existierenden Usern wird einfach ein
      // frischer Magic-Link geschickt.
      shouldCreateUser: true,
    },
  });

  if (error) {
    // Empfänger-Mail bewusst NICHT loggen (PII in Vercel-Logs vermeiden).
    console.error("[bordkasse:invite] Einladungs-Mail fehlgeschlagen:", error.message);
    return { ok: false, message: error.message };
  }
  return { ok: true };
}
