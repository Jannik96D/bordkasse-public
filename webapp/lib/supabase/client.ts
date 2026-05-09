import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase-Client für Client Components.
 * Singleton wäre möglich, aber bei Next-Hot-Reload pro Aufruf neu zu erstellen
 * ist robuster.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
