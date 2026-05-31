import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/origin";

export const dynamic = "force-dynamic";

/**
 * Magic-Link-Callback (PKCE-Flow).
 *
 * Hierher leitet Supabase mit `?code=…`, wenn das Email-Template
 * `{{ .ConfirmationURL }}` benutzt — wir tauschen den Code gegen eine
 * Session und leiten dann auf den ursprünglichen Ziel-Pfad weiter.
 *
 * Standard-Pfad in dieser App ist inzwischen `/auth/confirm` mit
 * Token-Hash, weil PKCE bei Cross-Browser-Klick ("PKCE code verifier not
 * found in storage") bricht. `/auth/callback` bleibt für Backward-
 * Kompatibilität (alte Mails, externe Login-Provider) erhalten.
 *
 * Bei Fehlern werden Fehlercode + Beschreibung als Query-Parameter an
 * `/login` weitergereicht, damit die Login-Page den Grund anzeigen kann.
 *
 * Cookie-Hinweis: die Redirect-Response wird VOR dem Supabase-Client
 * erzeugt und an `createClient(response)` übergeben — sonst landen die
 * Session-Cookies nicht auf der Antwort und der Browser bleibt
 * unangemeldet (siehe lib/supabase/server.ts).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  // Supabase-eigene Fehler werden als ?error=…&error_description=… übergeben.
  const supaError = url.searchParams.get("error");
  const supaErrorDescription = url.searchParams.get("error_description");
  if (supaError) {
    return redirectWithError(url.origin, supaError, supaErrorDescription ?? undefined);
  }

  if (!code) {
    return redirectWithError(
      url.origin,
      "no_code",
      "Magic-Link enthält keinen Auth-Code. Häufigste Ursache: Link in einem anderen Browser geöffnet als angefordert (PKCE-Verifier liegt in Cookies des Original-Browsers).",
    );
  }

  const response = NextResponse.redirect(new URL(next, url.origin));
  const supabase = await createClient(response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return redirectWithError(url.origin, error.code ?? "exchange_failed", error.message);
  }

  return response;
}

function redirectWithError(origin: string, code: string, message?: string) {
  const target = new URL("/login", origin);
  target.searchParams.set("auth_error", code);
  if (message) target.searchParams.set("auth_error_msg", message);
  return NextResponse.redirect(target);
}
