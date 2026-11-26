import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Cookieloser anon-Client für den Magic-Link-Versand (Login + Einladung).
 *
 * Der Versand braucht keine Session — die entsteht erst in `/auth/verify`.
 * Ein Cookie-Client würde beim Einladen sonst die Session des Skippers
 * berühren. Liefert `null`, wenn die Supabase-Config fehlt.
 */
export function createCookielessClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
