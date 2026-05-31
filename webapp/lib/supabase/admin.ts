import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Admin-Client mit Service-Role-Key.
 *
 * **Wichtig:** bypasst Row Level Security komplett — nur in Server Actions
 * verwenden, NACHDEM die Auth über getCurrentPerson()/auth.getUser()
 * verifiziert wurde. Niemals zum Browser exposieren.
 *
 * Hintergrund: In Next.js 16 + Supabase SSR erreicht das User-JWT die DB
 * im Server-Action-INSERT-Pfad nicht zuverlässig (RLS-Policies, die
 * `auth.uid()` benötigen, schlagen fehl). Wir prüfen die Auth daher
 * applikationsseitig und schreiben mit Service-Role.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY oder NEXT_PUBLIC_SUPABASE_URL fehlt — Admin-Client kann nicht erstellt werden.",
    );
  }
  return createSupabaseClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
