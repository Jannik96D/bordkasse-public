/**
 * Reply-To für Törn-/Reise-Mails: die Skipper- bzw. Reiseleitungs-Adresse.
 *
 * Antworten auf eine Bordkasse-Mail sollen bei einer Person landen, die sich
 * wirklich kümmert — nicht in einem Postfach, das niemand liest (und ein
 * gelesenes Antwort-Postfach hilft auch der Zustellbarkeit).
 *
 * REGEL (`resolveReplyTo`):
 *   1. Hat die AUSLÖSENDE Person eine Leitungsrolle in diesem Törn
 *      (Original-Skipper oder Co-Skipper/`is_skipper`), gilt ihre Adresse.
 *   2. Sonst (Crewmitglied löst aus, Cron, Admin ohne Törnrolle) gilt die
 *      Adresse des Original-Skippers (`trips.skipper_id`) — die Leitung als
 *      feste Ansprechperson.
 *   3. Keine Adresse / Lesefehler → `undefined` (dann greift in `send.ts`
 *      der optionale Standard `MAIL_REPLY_TO`, sonst kein Header).
 *
 * ⚠️ DATENSCHUTZ: `persons_private.email` ist per RLS nur für die Person selbst
 * und Törn-Skipper lesbar. Im Reply-To-Header sieht die ganze Crew die Adresse
 * der Leitung — das ist hier gewollt. Die Adresse eines normalen
 * Crewmitglieds gelangt NIE in einen Header (Regel 1 greift nur für
 * Leitungsrollen); deshalb fällt ein Crew-Auslöser auf Regel 2 zurück.
 *
 * Wirft nie (ein Lesefehler darf keine Mail verhindern), loggt nur Fehlercodes.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

export async function resolveReplyTo(
  supabase: SupabaseAdmin,
  tripId: string,
  actorPersonId?: string | null,
): Promise<string | undefined> {
  try {
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("skipper_id")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip?.skipper_id) return undefined;

    let leadId: string = trip.skipper_id;
    if (actorPersonId && actorPersonId !== trip.skipper_id) {
      const { data: member, error: memberErr } = await supabase
        .from("trip_members")
        .select("is_skipper")
        .eq("trip_id", tripId)
        .eq("person_id", actorPersonId)
        .maybeSingle();
      // Lesefehler → im Zweifel beim Original-Skipper bleiben (nie eine
      // Crew-Adresse veröffentlichen).
      if (!memberErr && member?.is_skipper === true) leadId = actorPersonId;
    }

    const { data: priv, error: privErr } = await supabase
      .from("persons_private")
      .select("email")
      .eq("person_id", leadId)
      .maybeSingle();
    if (privErr) return undefined;
    const email = typeof priv?.email === "string" ? priv.email.trim() : "";
    return email || undefined;
  } catch (err) {
    console.error("[bordkasse:mail] Reply-To nicht ermittelbar", { code: (err as { code?: unknown })?.code });
    return undefined;
  }
}
