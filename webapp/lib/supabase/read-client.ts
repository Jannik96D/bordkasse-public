import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/authz";

/**
 * Liefert einen Supabase-Client für Lese-Queries.
 *
 * - Für globale Admins (in `ADMIN_EMAILS`-Env): Service-Role-Client →
 *   bypasst RLS, kann alle Trips lesen. Notwendig, damit Admins fremde
 *   Törns aufrufen können (Trip-Dashboard, Crew-Liste, Buchungen, etc.).
 * - Für alle anderen: Cookie-basierter Client → RLS greift wie gewohnt.
 *
 * Schreib-Pfade nutzen weiterhin `createAdminClient()` direkt und prüfen
 * die Berechtigung im App-Code via `requireSkipper` / `requireMember`.
 */
export async function readClient() {
  if (await isAdmin()) return createAdminClient();
  return await createClient();
}
