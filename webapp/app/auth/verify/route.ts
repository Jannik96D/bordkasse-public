import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { normalizeEmail } from "@/lib/auth/email-param";
import {
  LOGIN_INTENT_COOKIE,
  LOGIN_INTENT_PATH,
  loginIntentMatches,
} from "@/lib/auth/login-intent";
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
  // `email` = Hinweis aus der (fälschbaren) URL; `typed_email` = vom Nutzer auf
  // /auth/confirm eingetippte Adresse (Fallback ohne Login-Intent-Cookie).
  const hint = formData.get("email")?.toString() || undefined;
  const typed = formData.get("typed_email")?.toString().trim() || undefined;
  const email = typed ?? hint;

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
  // Bereits eingeloggt als jemand anderes? Dann KEIN stilles Überschreiben und
  // der Token bleibt unverbraucht. Gleiche Person (erneuter Login) ist ok.
  const existing = await supabase.auth.getUser().catch(() => null);
  const existingEmail = existing?.data?.user?.email;
  if (existingEmail && (!email || normalizeEmail(existingEmail) !== normalizeEmail(email))) {
    // Nicht über /login: der Proxy leitet Eingeloggte von dort ohne Query auf
    // "/" um, die Meldung ginge verloren. Der globale Toast zeigt sie an.
    const target = new URL("/", origin);
    target.searchParams.set("toast", "login-session-exists");
    return NextResponse.redirect(target, { status: 303 });
  }

  const { data, error } = await supabase.auth.verifyOtp({ token_hash, type });
  if (error) {
    return redirectWithError(origin, error.code ?? "verify_failed", error.message, email);
  }

  // Login-CSRF-Schutz: ein untergeschobener Link (Token des Angreifers) darf
  // das Opfer nicht ins fremde Konto einloggen. Maßgeblich ist die Adresse des
  // Token-INHABERS (erst nach verifyOtp bekannt). Sie muss durch einen Beleg
  // des Nutzers gedeckt sein:
  //  - Cookie-Pfad: das Login-Intent-Cookie (HMAC, gesetzt beim Anfordern auf
  //    /login) passt zum Inhaber (der URL-Hinweis ist dafür nicht nötig und
  //    nicht maßgeblich);
  //  - Fallback (Cookie fehlt/andere Adresse, z. B. Skipper-Einladung oder
  //    anderes Gerät): der Nutzer hat die Adresse auf /auth/confirm selbst
  //    getippt (ohne Vorbelegung) und sie entspricht dem Inhaber. Wer einen
  //    Angreifer-Link bekommt, tippt seine EIGENE Adresse → Abweisung.
  // Der Token ist beim Vergleich bereits verbraucht (unvermeidbar: der Inhaber
  // ist vorher unbekannt) — im Missbrauchsfall gehörte er nicht dem Nutzer.
  const owner = data?.user?.email ?? data?.session?.user?.email;
  let proven = false;
  if (owner) {
    if (typed) {
      proven = normalizeEmail(owner) === normalizeEmail(typed);
    } else {
      proven = loginIntentMatches(owner, request.cookies.get(LOGIN_INTENT_COOKIE)?.value);
    }
  }
  if (!proven) {
    // Session widerrufen. Die bisher befüllte `response` (mit Session-Cookies)
    // wird bewusst VERWORFEN und eine frische Redirect-Response ohne Cookies
    // zurückgegeben — eine bereits bestehende Session des Browsers bleibt so
    // unberührt. Die übermittelte (womöglich fremde) Adresse wird nicht an
    // /login weitergereicht.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    return redirectWithError(
      origin,
      "email_mismatch",
      "Der Login-Link gehört zu einer anderen E-Mail-Adresse.",
    );
  }

  // Beleg ist verbraucht.
  response.cookies.delete({ name: LOGIN_INTENT_COOKIE, path: LOGIN_INTENT_PATH });
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
