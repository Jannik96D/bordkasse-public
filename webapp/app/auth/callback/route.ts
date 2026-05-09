import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-Link-Callback. Supabase redirected hierher mit ?code=… (PKCE)
 * oder mit Token-Hash-Fragmenten. Wir tauschen den Code gegen eine Session
 * aus und leiten dann auf den ursprünglichen Ziel-Pfad weiter.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }

  // Fehler oder kein Code → zurück auf Login
  return NextResponse.redirect(new URL("/login?auth_error=1", url.origin));
}
