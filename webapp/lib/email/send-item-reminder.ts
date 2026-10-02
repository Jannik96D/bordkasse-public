/**
 * Versand der automatischen Posten-Erinnerungen (PR5, Migration 0061).
 *
 * Die Beträge plant der Cron gesammelt (lib/prepayments/item-reminders.ts);
 * hier werden nur noch Name + E-Mail des Empfängers (und der Name des
 * Posten-Empfängers für die Crew-Mail) geladen und die Mail verschickt.
 *
 * Rückgabe wie `sendPrepaymentReminderMail`: `reason: "send_failed"` nur bei
 * einem ECHTEN Zustellungsfehler — alles andere (keine E-Mail hinterlegt,
 * Person weg) ist eine Dateneigenschaft und zählt im Cron als `skipped`
 * (Fund 3, PR 6).
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/send";
import { renderItemCrewReminderMail, renderItemPayeeReminderMail } from "@/lib/email/item-reminder-template";
import { formatDeDate, toCrewDueDate } from "@/lib/prepayments/dates";
import type { ItemReminderJob } from "@/lib/prepayments/item-reminders";
import { appOrigin } from "@/lib/auth/origin";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

export type ItemReminderResult =
  | { ok: true }
  | { ok: false; message: string; reason?: "send_failed"; code?: string; responseCode?: number };

/**
 * Knappe SMTP-Timeouts NUR für diese Erinnerungen (Review P2): ein hängender
 * Mailserver soll den Cron-Lauf nicht minutenlang blockieren. Andere Mails
 * (Abrechnung, Magic-Link …) behalten die nodemailer-Defaults.
 */
export const ITEM_MAIL_TIMEOUTS = { connectionTimeoutMs: 10_000, greetingTimeoutMs: 10_000, socketTimeoutMs: 20_000 } as const;

export interface ItemReminderContext {
  tripName: string;
  tripType: "sailing" | "other";
  item: { label: string; categoryName: string | null; dueDate: string; payeePersonId: string };
  /** Heute (ISO) — für den Clamp von toCrewDueDate, überschreibbar für Tests. */
  todayIso: string;
}

export async function sendItemReminderMail(
  supabase: SupabaseAdmin,
  job: ItemReminderJob,
  ctx: ItemReminderContext,
): Promise<ItemReminderResult> {
  const isCrew = job.type === "item_crew_3d";
  const ids = isCrew ? [job.personId, ctx.item.payeePersonId] : [job.personId];

  const [personsRes, privRes] = await Promise.all([
    supabase.from("persons").select("id, display_name").in("id", ids),
    supabase.from("persons_private").select("email").eq("person_id", job.personId).maybeSingle(),
  ]);
  // Ein Lesefehler ist kein „hat keine E-Mail" — als echter Fehler melden,
  // sonst sähe ein DB-Aussetzer im Cron wie eine harmlose Auslassung aus.
  if (personsRes.error) return { ok: false, message: personsRes.error.message, reason: "send_failed" };
  if (privRes.error) return { ok: false, message: privRes.error.message, reason: "send_failed" };

  const nameById = new Map((personsRes.data ?? []).map((p) => [p.id as string, p.display_name as string]));
  const recipientName = nameById.get(job.personId);
  if (!recipientName) return { ok: false, message: "Person nicht gefunden." };
  const email = privRes.data?.email as string | undefined;
  if (!email) return { ok: false, message: "Diese Person hat keine E-Mail-Adresse hinterlegt." };

  const appUrl = `${appOrigin()}/trips/${job.tripId}/prepayments`;
  const itemInfo = { label: ctx.item.label, categoryName: ctx.item.categoryName };

  const mail = isCrew
    ? renderItemCrewReminderMail({
        recipientName,
        payeeName: nameById.get(ctx.item.payeePersonId) ?? "die empfangende Person",
        tripName: ctx.tripName,
        tripType: ctx.tripType,
        item: itemInfo,
        crewDueDate: formatDeDate(toCrewDueDate(ctx.item.dueDate, ctx.todayIso)),
        amountOpen: job.amount,
        amountSoll: job.soll ?? job.amount,
        appUrl,
      })
    : renderItemPayeeReminderMail({
        recipientName,
        tripName: ctx.tripName,
        tripType: ctx.tripType,
        item: itemInfo,
        providerDueDate: formatDeDate(ctx.item.dueDate),
        providerSoll: job.overview?.providerSoll ?? 0,
        crewPaid: job.overview?.crewPaid ?? 0,
        crewSoll: job.overview?.crewSoll ?? 0,
        providerPaid: job.overview?.providerPaid ?? 0,
        providerOpen: job.overview?.providerOpen ?? job.amount,
        ownOpen: job.overview?.ownOpen ?? 0,
        appUrl,
      });

  const result = await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text }, ITEM_MAIL_TIMEOUTS);
  if (!result.ok) {
    return { ok: false, message: result.error, reason: "send_failed", code: result.code, responseCode: result.responseCode };
  }
  return { ok: true };
}
