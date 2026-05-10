import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

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
 * mit "code verifier not found in storage" ab.
 *
 * Damit Supabase diesen Flow nutzt, muss die Email-Template-Variable
 * `{{ .ConfirmationURL }}` durch
 *   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}`
 * ersetzt werden.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/";

  if (!token_hash || !type) {
    const target = new URL("/login", url.origin);
    target.searchParams.set("auth_error", "missing_token");
    target.searchParams.set(
      "auth_error_msg",
      "Der Login-Link enthält keinen gültigen Token. Fordere einen neuen an.",
    );
    return NextResponse.redirect(target);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash, type });
  if (error) {
    const target = new URL("/login", url.origin);
    target.searchParams.set("auth_error", error.code ?? "verify_failed");
    target.searchParams.set("auth_error_msg", error.message);
    return NextResponse.redirect(target);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
