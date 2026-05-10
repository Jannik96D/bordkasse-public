import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

/**
 * Supabase-Client für Server Components / Route Handlers / Server Actions.
 *
 * Liest Session aus Cookies. Schreibt aktualisierte Session-Cookies wahlweise
 * direkt auf eine `NextResponse` (Route Handlers, in denen wir Redirects
 * zurückgeben — `cookies().set()` greift dort nicht zuverlässig auf die
 * Redirect-Antwort durch) oder über `next/headers` (Server Components +
 * Server Actions, wo Next.js die gesetzten Cookies an die nächste Antwort
 * heftet).
 *
 * Empfohlen: in `/auth/confirm` und `/auth/callback` zuerst die Redirect-
 * Response erzeugen und dann `createClient(response)` aufrufen — nur so
 * landen die Set-Cookie-Header garantiert beim Browser. Siehe Supabase
 * Discussion #35615.
 */
export async function createClient(response?: NextResponse) {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          if (response) {
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
            return;
          }
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Read-only-Kontexte (Server Components) verwerfen Set-Versuche;
            // die Middleware refresht beim nächsten Request neu.
          }
        },
      },
    },
  );
}
