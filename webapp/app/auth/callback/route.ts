import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-Link-Callback. Supabase redirected hierher mit ?code=… (PKCE)
 * oder mit Token-Hash-Fragmenten. Wir tauschen den Code gegen eine Session
 * aus und leiten dann auf den ursprünglichen Ziel-Pfad weiter.
 *
 * Bei Fehlern werden Fehlercode + Beschreibung als Query-Parameter an
 * /login weitergereicht, damit die Login-Page den Grund anzeigen kann
 * (statt nur „auth_error=1").
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  // Supabase-eigene Fehler werden als ?error=…&error_description=… übergeben.
  const supaError = url.searchParams.get("error");
  const supaErrorDescription = url.searchParams.get("error_description");
  if (supaError) {
    const target = new URL("/login", url.origin);
    target.searchParams.set("auth_error", supaError);
    if (supaErrorDescription) target.searchParams.set("auth_error_msg", supaErrorDescription);
    return NextResponse.redirect(target);
  }

  if (!code) {
    const target = new URL("/login", url.origin);
    target.searchParams.set("auth_error", "no_code");
    target.searchParams.set(
      "auth_error_msg",
      "Magic-Link enthält keinen Auth-Code. Häufigste Ursache: Link in einem anderen Browser geöffnet als angefordert (PKCE-Verifier liegt in Cookies des Original-Browsers).",
    );
    return NextResponse.redirect(target);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const target = new URL("/login", url.origin);
    target.searchParams.set("auth_error", error.code ?? "exchange_failed");
    target.searchParams.set("auth_error_msg", error.message);
    return NextResponse.redirect(target);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
