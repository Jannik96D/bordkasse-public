import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Token-Hash-Flow für Magic-Link / E-Mail-Bestätigung.
 *
 * Im Gegensatz zum PKCE-Flow (siehe /auth/callback) braucht dieser Flow
 * KEINEN Code-Verifier im Browser-Storage — der Token wird direkt in der
 * URL übergeben und serverseitig per verifyOtp gegen die Auth-DB geprüft.
 *
 * Vorteil: der User kann den Magic-Link in einem anderen Browser klicken
 * als in dem er ihn angefordert hat (typisch: Anforderung am Desktop,
 * Klick im iOS-Mail-Webview oder umgekehrt). PKCE bricht in diesem Fall
 * mit „code verifier not found in storage" ab.
 *
 * Damit Supabase diesen Flow nutzt, muss die Email-Template-Variable
 * `{{ .ConfirmationURL }}` durch
 *   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}`
 * ersetzt werden.
 *
 * Cookie-Hinweis: die Redirect-Response wird VOR dem Supabase-Client
 * erzeugt und an `createClient(response)` übergeben — sonst landen die
 * Session-Cookies nicht auf der Antwort und der Browser bleibt
 * unangemeldet (siehe lib/supabase/server.ts).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/";

  if (!token_hash || !type) {
    return redirectWithError(
      url.origin,
      "missing_token",
      "Der Login-Link enthält keinen gültigen Token. Fordere einen neuen an.",
    );
  }

  // Redirect-Response zuerst erstellen, dann den Supabase-Client damit binden
  // — verifyOtp schreibt die Session-Cookies dann direkt auf diese Response.
  const response = NextResponse.redirect(new URL(next, url.origin));
  const supabase = await createClient(response);
  const { error } = await supabase.auth.verifyOtp({ token_hash, type });
  if (error) {
    return redirectWithError(url.origin, error.code ?? "verify_failed", error.message);
  }

  return response;
}

function redirectWithError(origin: string, code: string, message: string) {
  const target = new URL("/login", origin);
  target.searchParams.set("auth_error", code);
  target.searchParams.set("auth_error_msg", message);
  return NextResponse.redirect(target);
}
