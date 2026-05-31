"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEmailAllowedToSignIn } from "@/lib/auth/authz";
import { resolveOrigin } from "@/lib/auth/origin";

const LoginSchema = z.object({
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben."),
});

// Rate-Limit für Magic-Link-Anforderungen (Postgres-gestützt, siehe Migration
// 0036). E-Mail strikt — eine Person braucht selten >3 Links in 15 Min. IP
// großzügig — eine ganze Crew kann am Törn-Start über dasselbe Boots-WLAN/NAT
// kommen und darf sich nicht gegenseitig aussperren.
const RL_WINDOW_SECONDS = 15 * 60;
const RL_MAX_PER_EMAIL = 3;
const RL_MAX_PER_IP = 20;

/**
 * Zählt einen Login-Versuch für E-Mail UND IP und meldet, ob er erlaubt ist.
 * Fail-open: hakt die DB, lassen wir den Login durch — der Limiter ist ein
 * Schutznetz, kein Auth-Gate (die Whitelist schützt weiterhin).
 */
async function withinRateLimit(emailKey: string, ip: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const [emailRes, ipRes] = await Promise.all([
      admin.rpc("bump_login_rate_limit", {
        p_key: `email:${emailKey}`,
        p_max: RL_MAX_PER_EMAIL,
        p_window_seconds: RL_WINDOW_SECONDS,
      }),
      admin.rpc("bump_login_rate_limit", {
        p_key: `ip:${ip}`,
        p_max: RL_MAX_PER_IP,
        p_window_seconds: RL_WINDOW_SECONDS,
      }),
    ]);
    if (emailRes.error || ipRes.error) {
      console.error(
        "[bordkasse:ratelimit]",
        emailRes.error?.message ?? ipRes.error?.message,
      );
      return true; // fail-open
    }
    return emailRes.data !== false && ipRes.data !== false;
  } catch (e) {
    console.error("[bordkasse:ratelimit]", e instanceof Error ? e.message : "unbekannt");
    return true; // fail-open
  }
}

export type LoginState =
  | { status: "idle" }
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

export async function signInWithMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe.",
    };
  }

  const hdrs = await headers();
  const fwd = hdrs.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || hdrs.get("x-real-ip") || "unknown";

  // Rate-Limit VOR Whitelist + Mailversand — schützt beide Ressourcen
  // (DB-Lookup + Supabase-Auth-Mail) gegen Flutung. Schlüssel klein­geschrieben,
  // damit Groß-/Kleinschreibung der E-Mail das Limit nicht umgeht.
  if (!(await withinRateLimit(parsed.data.email.toLowerCase(), ip))) {
    return {
      status: "error",
      message: "Zu viele Login-Anfragen. Bitte in ein paar Minuten erneut versuchen.",
    };
  }

  // Nur E-Mails zulassen, die als Admin in ADMIN_EMAILS oder als Crew-
  // Mitglied (persons_private aus inviteMember / createTrip) hinterlegt
  // sind. Verhindert, dass Fremde via Magic-Link-Anforderung auth.users-
  // Rows produzieren, die niemand sieht und nirgendwo zugeordnet sind.
  const allowed = await isEmailAllowedToSignIn(parsed.data.email);
  if (!allowed) {
    return {
      status: "error",
      message:
        "Diese E-Mail-Adresse ist nicht für die Bordkasse hinterlegt. Bitte deinen Skipper, dich einzuladen.",
    };
  }

  const supabase = await createClient();
  const origin = resolveOrigin(hdrs.get("origin"));

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    console.error("[bordkasse:auth]", error.message);
    return { status: "error", message: "Login-Link konnte nicht versandt werden. Bitte später erneut versuchen." };
  }

  return { status: "ok", email: parsed.data.email };
}
