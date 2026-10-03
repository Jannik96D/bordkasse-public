"use server";

/**
 * Manuelle Erinnerung für eine weitere Zahlung (🔔 in der Personenliste).
 * Gleiche Mails wie der Cron (`send-item-reminder`), ausgelöst von Skipper,
 * Admin oder der vorstreckenden Person des Postens. Nur Mail (wie die
 * Glocke des Anzahlungsplans), kein Dedup-Log. Ohne Frist keine Erinnerung.
 */

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipperAdminOrItemPayee } from "@/lib/auth/authz";
import { assertTripNotArchived } from "@/lib/auth/trip-state";
import { getItems } from "@/lib/queries/prepayment-items";
import { planManualItemReminder } from "@/lib/prepayments/item-reminders";
import { sendItemReminderMail } from "@/lib/email/send-item-reminder";
import { todayIso } from "@/lib/utils";

const Schema = z.object({
  trip_id: z.string().uuid(),
  item_id: z.string().uuid(),
  person_id: z.string().uuid(),
});

export type ItemReminderState = { status: "idle" } | { status: "ok" } | { status: "error"; message: string };

const NOT_FOUND = "Diese Zahlung wurde nicht gefunden oder du hast keine Berechtigung.";

export async function sendItemReminder(_prev: ItemReminderState, formData: FormData): Promise<ItemReminderState> {
  const parsed = Schema.safeParse({
    trip_id: formData.get("trip_id"),
    item_id: formData.get("item_id"),
    person_id: formData.get("person_id"),
  });
  if (!parsed.success) return { status: "error", message: "Ungültige Eingabe." };
  const { trip_id: tripId, item_id: itemId, person_id: personId } = parsed.data;

  const auth = await requireSkipperAdminOrItemPayee(itemId);
  if (!auth.ok) return { status: "error", message: auth.message };
  if (auth.tripId !== tripId) return { status: "error", message: NOT_FOUND };

  const supabase = createAdminClient();
  const archived = await assertTripNotArchived(supabase, tripId);
  if (!archived.ok) return { status: "error", message: archived.message };

  let item;
  try {
    item = (await getItems(tripId)).find((i) => i.id === itemId);
  } catch {
    return { status: "error", message: "Die Zahlung konnte nicht geladen werden. Bitte erneut versuchen." };
  }
  if (!item) return { status: "error", message: NOT_FOUND };
  if (!item.due_date) {
    return { status: "error", message: "Für diese Zahlung ist keine Frist hinterlegt — bitte zuerst eine Frist eintragen." };
  }

  const plan = planManualItemReminder(item, personId);
  if (!plan.ok) return { status: "error", message: plan.message };

  const { data: trip, error } = await supabase.from("trips").select("name, trip_type").eq("id", tripId).maybeSingle();
  if (error || !trip) return { status: "error", message: "Der Törn konnte nicht geladen werden." };

  const result = await sendItemReminderMail(supabase, plan.job, {
    tripName: trip.name as string,
    tripType: trip.trip_type === "other" ? "other" : "sailing",
    item: { label: item.label, categoryName: item.category_name, dueDate: item.due_date, payeePersonId: item.payee_person_id },
    todayIso: todayIso(),
  });
  if (!result.ok) return { status: "error", message: result.message };
  return { status: "ok" };
}
