"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

/**
 * SSRF-Schutz: Der `endpoint` wird serverseitig von web-push per HTTPS-POST
 * angefragt. Ohne Einschränkung könnte ein eingeloggter Nutzer einen internen
 * Host hinterlegen (Cloud-Metadata 169.254.169.254, 10.x, localhost …) und so
 * Server-Requests dorthin auslösen. Wir lassen daher nur die echten Push-
 * Dienste der Browser-Hersteller zu (https-only). Liste bei Bedarf erweitern.
 */
const ALLOWED_PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome / Edge / Android / Samsung Internet (FCM)
  "web.push.apple.com", // Safari / iOS / iPadOS
  "updates.push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Microsoft WNS (regionale Subdomains)
];

function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some((s) =>
    s.startsWith(".") ? host.endsWith(s) : host === s,
  );
}

const SubscriptionSchema = z.object({
  // .url() + Längen-Cap + Host-Allowlist (SSRF + Bloat-Schutz).
  endpoint: z.string().url().max(2048).refine(isAllowedPushEndpoint, "Unbekannter Push-Dienst."),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export type SavePushResult = { ok: true } | { ok: false; message: string };
export type DeletePushResult = { ok: true; deleted: boolean } | { ok: false; message: string };

/**
 * Speichert (oder aktualisiert) das Web-Push-Abo DES AKTUELLEN GERÄTS für die
 * eingeloggte Person. Upsert auf `endpoint`: ein Gerät, das sich erneut
 * subscribed, überschreibt seinen alten Eintrag statt zu duplizieren — und ein
 * an einen anderen Account übergegangenes Gerät wird sauber umgehängt.
 */
export async function savePushSubscription(
  raw: unknown,
  userAgent?: string,
): Promise<SavePushResult> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };

  const parsed = SubscriptionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Ungültiges Abo." };

  const supabase = createAdminClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      person_id: person.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      user_agent: userAgent?.slice(0, 400) ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) {
    console.error("[bordkasse:push] Abo speichern fehlgeschlagen:", error.message);
    return { ok: false, message: "Abo konnte nicht gespeichert werden." };
  }
  return { ok: true };
}

/**
 * Entfernt das Abo des aktuellen Geräts (per Endpoint), gefiltert auf die
 * eigene person_id. Liefert `deleted` zurück (gehörte das Geräte-Abo wirklich
 * dem aktuellen Nutzer?) — der Client kündigt das BROWSER-Abo nur dann, sonst
 * würde er auf einem geteilten Gerät das Abo eines anderen Accounts killen.
 */
export async function deletePushSubscription(endpoint: string): Promise<DeletePushResult> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };
  if (!endpoint) return { ok: false, message: "Kein Endpoint." };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("person_id", person.id)
    .select("id");
  if (error) {
    console.error("[bordkasse:push] Abo löschen fehlgeschlagen:", error.message);
    return { ok: false, message: "Abo konnte nicht entfernt werden." };
  }
  return { ok: true, deleted: (data?.length ?? 0) > 0 };
}
