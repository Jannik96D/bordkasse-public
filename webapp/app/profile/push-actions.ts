"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type SavePushResult = { ok: true } | { ok: false; message: string };

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
 * Entfernt das Abo des aktuellen Geräts (per Endpoint). Zusätzlich auf die
 * eigene person_id gefiltert — niemand kann fremde Abos löschen
 * (Defense-in-Depth, auch wenn ein Endpoint praktisch nicht erratbar ist).
 */
export async function deletePushSubscription(endpoint: string): Promise<SavePushResult> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };
  if (!endpoint) return { ok: false, message: "Kein Endpoint." };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("person_id", person.id);
  if (error) {
    console.error("[bordkasse:push] Abo löschen fehlgeschlagen:", error.message);
    return { ok: false, message: "Abo konnte nicht entfernt werden." };
  }
  return { ok: true };
}
