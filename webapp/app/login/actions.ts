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

/**
 * Ermittelt die Client-IP fürs Rate-Limiting.
 *
 * SICHERHEIT: `x-forwarded-for` ist clientseitig frei setzbar — ein Angreifer
 * kann bei jedem Request eine beliebige, zufällige "IP" mitschicken und so
 * das IP-Rate-Limit trivial umgehen, wenn man naiv den LINKESTEN (ersten)
 * Eintrag nimmt (das war der ursprüngliche Bug hier).
 *
 * ⚠️ Grill-Review-Korrektur: `x-real-ip` wird HIER BEWUSST NICHT bevorzugt.
 * Anders als z. B. Nginx setzt Traefik `X-Real-Ip` nicht automatisch — nur
 * wenn eine dafür konfigurierte Middleware/ein Plugin existiert. Im Repo
 * findet sich dafür KEIN Beleg (kein `trustedIPs`, keine entsprechende
 * Traefik-Config eingecheckt — die Coolify-verwaltete Traefik-Konfiguration
 * lebt außerhalb dieses Repos). Ohne diese Garantie könnte ein Angreifer
 * einfach selbst `X-Real-Ip: 1.2.3.4` mitschicken und Traefik würde diesen
 * Header unverändert durchreichen — exakt derselbe Bug wie vorher, nur unter
 * anderem Header-Namen.
 *
 * Stattdessen wird ausschließlich der LETZTE Eintrag von `x-forwarded-for`
 * genutzt: das ist eine strukturelle Garantie praktisch jedes Reverse-Proxys
 * (auch ohne Sonderkonfiguration) — ein Proxy HÄNGT die IP seines direkten
 * TCP-Peers an einen ggf. vom Client mitgeschickten XFF-Header AN, er ersetzt
 * ihn nicht. Der letzte Eintrag ist deshalb immer der, den der unmittelbare
 * Proxy selbst gesehen hat; alles davor kann der Client gefälscht haben.
 * Vorausgesetzt: Traefik ist laut Hosting-Setup der EINZIGE Hop zwischen
 * Client und App-Container (kein CDN/zusätzlicher Load Balancer davor) — vor
 * dem Produktions-Deploy trotzdem einmal gegen den echten Traffic verifizieren
 * (siehe Hinweis im PR/Commit).
 *
 * Fehlt `x-forwarded-for` ebenfalls (z. B. lokal ohne Proxy): `"unknown"` als
 * Fail-Open-Fallback (unverändertes Verhalten — das Limit greift dann nur
 * noch global über den `ip:unknown`-Schlüssel).
 */
export function resolveClientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}

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
  const ip = resolveClientIp(hdrs);

  // Rate-Limit VOR Whitelist + Mailversand — schützt beide Ressourcen
  // (DB-Lookup + Supabase-Auth-Mail) gegen Flutung. Schlüssel klein­geschrieben,
  // damit Groß-/Kleinschreibung der E-Mail das Limit nicht umgeht.
  //
  // Oracle-Schutz: bei Überschreitung geben wir denselben neutralen
  // Erfolgs-Zustand zurück wie bei tatsächlichem Mailversand — ein Angreifer,
  // der E-Mails durchprobiert, soll am Antwortverhalten nicht erkennen können,
  // wann er das Limit trifft. Kein Mailversand, aber intern sichtbar geloggt.
  if (!(await withinRateLimit(parsed.data.email.toLowerCase(), ip))) {
    console.warn("[bordkasse:ratelimit] Login-Anfrage rate-limitiert", {
      email: parsed.data.email.toLowerCase(),
      ip,
    });
    return { status: "ok", email: parsed.data.email };
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
