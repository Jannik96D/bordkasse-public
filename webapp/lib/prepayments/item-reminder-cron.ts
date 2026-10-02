/**
 * Posten-Teil des täglichen Anzahlungs-Crons (PR5, Migration 0061).
 *
 * Läuft im selben Cron-Lauf wie die Tranchen-Erinnerungen
 * (app/api/cron/prepayment-reminders/route.ts) — kein eigener Coolify-Task.
 *
 * FAIL-SOFT: dieser Teil wirft nie. Fehlt die Tabelle (App vor Migration
 * deployt) oder scheitert eine Lese-Query, zählt das als EIN `failed` mit
 * `console.error` und es geht KEINE Mail raus (ohne vollständige Daten bzw.
 * ohne Dedup-Log würde sonst falsch oder täglich erneut gemahnt). Der
 * Tranchen-Teil des Laufs bleibt davon unberührt.
 *
 * Send-first wie bei den Tranchen (Fund 3, PR 6): Mail zuerst, danach der
 * Log-Eintrag; eine Unique-Violation (23505, paralleler Lauf) ist harmlos,
 * jeder andere Log-Fehler zählt als `failed` (Mail ist trotzdem raus).
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { addDays } from "@/lib/prepayments/dates";
import { ITEM_CREW_WINDOW_DAYS, planItemReminderJobs, type ItemReminderJob } from "@/lib/prepayments/item-reminders";
import { sendItemReminderMail } from "@/lib/email/send-item-reminder";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { itemPayeeReminderPush, itemReminderPush } from "@/lib/notify/payloads";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

export interface ItemReminderRunResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: Array<{ type: string; message: string; kind: "skipped" | "failed" }>;
}

const empty = (): ItemReminderRunResult => ({ processed: 0, sent: 0, skipped: 0, failed: 0, errors: [] });

function loadFailed(what: string, message: string): ItemReminderRunResult {
  console.error(`[bordkasse:cron] item reminders: ${what} failed:`, message);
  return { ...empty(), failed: 1, errors: [{ type: "item_load", message: `${what}: ${message}`, kind: "failed" }] };
}

export async function runItemReminders(supabase: SupabaseAdmin, todayIso: string): Promise<ItemReminderRunResult> {
  try {
    return await runInner(supabase, todayIso);
  } catch (e) {
    return loadFailed("run", e instanceof Error ? e.message : String(e));
  }
}

async function runInner(supabase: SupabaseAdmin, todayIso: string): Promise<ItemReminderRunResult> {
  const windowEnd = addDays(todayIso, ITEM_CREW_WINDOW_DAYS);

  // Nur Posten mit Fälligkeit im größten Fenster (Crew, 6 Tage). Ohne
  // Fälligkeit → nie eine Erinnerung.
  const itemsRes = await supabase
    .from("prepayment_items")
    .select("id, trip_id, category_id, label, total_amount, due_date, payee_person_id")
    .not("due_date", "is", null)
    .gte("due_date", todayIso)
    .lte("due_date", windowEnd);
  if (itemsRes.error) return loadFailed("prepayment_items", itemsRes.error.message);
  const items = itemsRes.data ?? [];
  if (items.length === 0) return empty();

  const itemIds = items.map((i) => i.id as string);
  const tripIds = [...new Set(items.map((i) => i.trip_id as string))];
  const categoryIds = [...new Set(items.map((i) => i.category_id as string | null).filter((c): c is string => !!c))];

  const [tripsRes, oblRes, paidRes, pendingRes, providerRes, logRes, catRes] = await Promise.all([
    supabase.from("trips").select("id, name, trip_type, end_date, archived, retention_purged_at").in("id", tripIds),
    supabase.from("prepayment_item_obligations").select("item_id, person_id, amount").in("item_id", itemIds),
    supabase.from("v_prepayment_item_payments").select("item_id, person_id, paid_amount").in("item_id", itemIds),
    supabase.from("v_prepayment_item_pending").select("item_id, person_id, amount").in("item_id", itemIds),
    supabase
      .from("transactions")
      .select("item_id, amount")
      .in("item_id", itemIds)
      .eq("type", "expense")
      .is("deleted_at", null),
    supabase.from("prepayment_item_reminder_log").select("item_id, person_id, reminder_type").in("item_id", itemIds),
    categoryIds.length > 0
      ? supabase.from("trip_categories").select("id, name").in("id", categoryIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
  ]);
  // Jeder Lesefehler bricht den Posten-Teil ab: eine fehlende Zahlungsliste
  // sähe wie „niemand hat gezahlt" aus, ein fehlendes Log wie „noch nie
  // erinnert" — beides würde falsch mahnen.
  if (tripsRes.error) return loadFailed("trips", tripsRes.error.message);
  if (oblRes.error) return loadFailed("prepayment_item_obligations", oblRes.error.message);
  if (paidRes.error) return loadFailed("v_prepayment_item_payments", paidRes.error.message);
  if (pendingRes.error) return loadFailed("v_prepayment_item_pending", pendingRes.error.message);
  if (providerRes.error) return loadFailed("transactions", providerRes.error.message);
  if (logRes.error) return loadFailed("prepayment_item_reminder_log", logRes.error.message);
  if (catRes.error) return loadFailed("trip_categories", catRes.error.message);

  const trips = (tripsRes.data ?? []) as Array<{
    id: string;
    name: string;
    trip_type: string | null;
    end_date: string | null;
    archived: boolean | null;
    retention_purged_at: string | null;
  }>;
  const jobs = planItemReminderJobs({
    todayIso,
    items: items.map((i) => ({
      id: i.id as string,
      trip_id: i.trip_id as string,
      label: i.label as string,
      total_amount: Number(i.total_amount),
      due_date: (i.due_date as string | null) ?? null,
      payee_person_id: i.payee_person_id as string,
    })),
    trips,
    obligations: (oblRes.data ?? []).map((o) => ({ item_id: o.item_id, person_id: o.person_id, amount: Number(o.amount) })),
    payments: (paidRes.data ?? []).map((p) => ({ item_id: p.item_id, person_id: p.person_id, paid_amount: Number(p.paid_amount) })),
    pending: (pendingRes.data ?? []).map((p) => ({ item_id: p.item_id, person_id: p.person_id, amount: Number(p.amount) })),
    providerPayments: (providerRes.data ?? [])
      .filter((t) => t.item_id)
      .map((t) => ({ item_id: t.item_id as string, amount: Number(t.amount) })),
    sentLog: logRes.data ?? [],
  });

  const tripById = new Map(trips.map((t) => [t.id, t]));
  const itemById = new Map(items.map((i) => [i.id as string, i]));
  const catName = new Map((catRes.data ?? []).map((c) => [c.id as string, c.name as string]));

  const result = empty();
  result.processed = jobs.length;

  for (const job of jobs) {
    const item = itemById.get(job.itemId)!;
    const trip = tripById.get(job.tripId)!;
    try {
      const mail = await sendItemReminderMail(supabase, job, {
        tripName: trip.name,
        tripType: trip.trip_type === "other" ? "other" : "sailing",
        item: {
          label: item.label as string,
          categoryName: item.category_id ? (catName.get(item.category_id as string) ?? null) : null,
          dueDate: item.due_date as string,
          payeePersonId: item.payee_person_id as string,
        },
        todayIso,
      });
      if (!mail.ok) {
        const kind = mail.reason === "send_failed" ? "failed" : "skipped";
        result[kind]++;
        if (kind === "failed") console.error("[bordkasse:cron] item mail send failed:", { job: jobRef(job), message: mail.message });
        result.errors.push({ type: job.type, message: mail.message, kind });
        continue;
      }

      const { error: logErr } = await supabase.from("prepayment_item_reminder_log").insert({
        trip_id: job.tripId,
        item_id: job.itemId,
        person_id: job.personId,
        reminder_type: job.type,
      });
      if (logErr) {
        if (logErr.code === "23505") {
          console.warn("[bordkasse:cron] item log insert (dedupe, parallel run):", logErr.message);
        } else {
          result.failed++;
          console.error("[bordkasse:cron] item log insert failed:", { job: jobRef(job), message: logErr.message });
          result.errors.push({ type: job.type, message: `Dedup-Log fehlgeschlagen: ${logErr.message}`, kind: "failed" });
        }
      }

      // Push additiv nach der Mail (wirft nie); der Dedup-Log deckt beide Kanäle.
      const pushArgs = {
        itemLabel: item.label as string,
        amount: job.amount,
        tripName: trip.name,
        tripId: job.tripId,
        itemId: job.itemId,
      };
      await sendPushToPersons(
        supabase,
        [job.personId],
        job.type === "item_crew_3d" ? itemReminderPush(pushArgs) : itemPayeeReminderPush(pushArgs),
      );

      result.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[bordkasse:cron] item job failed:", { job: jobRef(job), msg });
      result.errors.push({ type: job.type, message: msg, kind: "failed" });
      result.failed++;
    }
  }

  return result;
}

/** Log-Referenz ohne Beträge/Namen (IDs reichen fürs Debugging). */
function jobRef(job: ItemReminderJob) {
  return { type: job.type, itemId: job.itemId, tripId: job.tripId, personId: job.personId };
}
