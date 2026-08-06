import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requestMayRedeemToken, resolveRedirectOrigin, safeNextPath } from "@/lib/auth/origin";

export const dynamic = "force-dynamic";

/**
 * Verifiziert den Magic-Link-Token. Wird vom Klick-Bestätigungs-Formular
 * auf /auth/confirm aus per POST aufgerufen — nie direkt via GET-Link,
 * damit Mail-Link-Scanner den Token nicht versehentlich verbrauchen.
 *
 * Cookies werden direkt auf die Redirect-Response gehängt (Pattern aus
 * lib/supabase/server.ts), sonst landen die Session-Cookies nicht im
 * Browser des Users.
 *
 * Bei Fehlern (insbesondere otp_expired) wird die Empfänger-E-Mail mit
 * an /login durchgereicht, damit die Login-Page einen Auto-Resend-Button
 * für genau diese Adresse zeigen kann.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const token_hash = formData.get("token_hash")?.toString();
  const type = formData.get("type")?.toString() as EmailOtpType | null;
  const next = safeNextPath(formData.get("next")?.toString());
  const email = formData.get("email")?.toString() ?? undefined;

  // Weder `new URL(request.url).origin` (liefert hinter Traefik/Coolify
  // `0.0.0.0:3000`, der Redirect zeigt ins Leere) noch `resolveOrigin` (wirft
  // fail-loud → nackter 500 auf dem Klick-Pfad). Details siehe
  // resolveRedirectOrigin in lib/auth/origin.ts.
  const origin = resolveRedirectOrigin(request.headers, request.url);

  if (!token_hash || !type) {
    return redirectWithError(
      origin,
      "missing_token",
      "Der Login-Link enthält keinen gültigen Token. Fordere einen neuen an.",
      email,
    );
  }

  // WICHTIG: vor `verifyOtp`. Ein Request über eine nicht erlaubte Domain (oder
  // ein Cross-Origin-POST) würde den Single-Use-Token sonst verbrauchen, ohne
  // dass eine nutzbare Session entsteht — siehe requestMayRedeemToken.
  if (!requestMayRedeemToken(request.headers, request.url)) {
    return redirectWithError(
      origin,
      "untrusted_host",
      "Der Login wurde über eine nicht freigegebene Adresse aufgerufen. Öffne die App direkt und fordere einen neuen Link an.",
      email,
    );
  }

  // Response zuerst, damit der Cookie-Adapter aus createClient(response)
  // die Set-Cookie-Header direkt auf den Redirect schreibt.
  // 303 (See Other) zwingt den Browser auf GET — sonst würde ein POST auf
  // die Home-Route weitergehen und der Server-Component-Render scheitern.
  const response = NextResponse.redirect(new URL(next, origin), { status: 303 });
  const supabase = await createClient(response);
  const { error } = await supabase.auth.verifyOtp({ token_hash, type });
  if (error) {
    return redirectWithError(origin, error.code ?? "verify_failed", error.message, email);
  }

  return response;
}

function redirectWithError(
  origin: string,
  code: string,
  message: string,
  email?: string,
) {
  const target = new URL("/login", origin);
  target.searchParams.set("auth_error", code);
  target.searchParams.set("auth_error_msg", message);
  if (email) target.searchParams.set("email", email);
  return NextResponse.redirect(target, { status: 303 });
}
