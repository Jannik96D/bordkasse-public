"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { iconForCategoryName } from "@/lib/categories/icons";

// Reihenfolge bewusst gewählt — siehe `docs/categories.md` bzw. README.
// Crew-User-Feedback: zuerst die im Alltag häufigen (Lebensmittel, Restaurant),
// dann Hafen/Aktivitäten/Ausrüstung, dann Verbrauchs- + Verwaltungs-Sachen.
const DEFAULT_CATEGORY_NAMES = [
  "Lebensmittel",
  "Restaurant",
  "Hafen / Liegeplatz",
  "Aktivitäten",
  "Ausrüstung",
  "Sprit",
  "Yacht",
  "Versicherung",
  "Kaution",
  "Sonstiges",
] as const;

const DEFAULT_CATEGORIES = DEFAULT_CATEGORY_NAMES.map((name) => ({
  name,
  icon: iconForCategoryName(name),
}));

const TripSchema = z
  .object({
    name: z.string().trim().min(2, "Name muss mindestens 2 Zeichen haben.").max(80),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    ship_name: z.string().trim().max(80).optional().or(z.literal("")),
    // Wenn gesetzt, wird dieser User Skipper statt der Admin selbst —
    // damit der Admin Törns für andere anlegen kann ohne hinterher
    // wieder rausgeworfen werden zu müssen.
    skipper_email: z.string().trim().email("Ungültige Skipper-E-Mail.").optional().or(z.literal("")),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: "Törn-Ende darf nicht vor dem Start liegen.",
    path: ["end_date"],
  });

export type TripState =
  | { status: "idle" }
  | { status: "error"; message: string };

export async function createTrip(_prev: TripState, formData: FormData): Promise<TripState> {
  const auth = await requireAdmin();
  if (!auth.ok) return { status: "error", message: auth.message };

  const parsed = TripSchema.safeParse({
    name: formData.get("name"),
    start_date: formData.get("start_date"),
    end_date: formData.get("end_date"),
    ship_name: formData.get("ship_name") || "",
    skipper_email: formData.get("skipper_email") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const supabase = createAdminClient();

  // Skipper bestimmen: wenn skipper_email angegeben ist, dort eine Person
  // finden oder als Ghost anlegen — sonst wird der Admin selbst Skipper.
  // E-Mail-Lookup geht seit Migration 0013 über persons_private.
  let skipperId = auth.personId;
  if (parsed.data.skipper_email) {
    const email = parsed.data.skipper_email;
    const { data: existingPriv } = await supabase
      .from("persons_private")
      .select("person_id")
      .ilike("email", email)
      .maybeSingle();
    if (existingPriv) {
      skipperId = existingPriv.person_id;
    } else {
      const fallbackName = email.split("@")[0];
      const { data: created, error: pErr } = await supabase
        .from("persons")
        .insert({ display_name: fallbackName })
        .select("id")
        .single();
      if (pErr || !created) {
        return { status: "error", message: pErr?.message ?? "Skipper-Person konnte nicht angelegt werden." };
      }
      skipperId = created.id;
      const { error: privErr } = await supabase
        .from("persons_private")
        .insert({ person_id: created.id, email });
      if (privErr) {
        return { status: "error", message: privErr.message };
      }
    }
  }

  const { data: trip, error } = await supabase
    .from("trips")
    .insert({
      name: parsed.data.name,
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
      ship_name: parsed.data.ship_name || null,
      skipper_id: skipperId,
    })
    .select()
    .single();

  if (error || !trip) {
    if (error?.message) console.error("[bordkasse:db]", error.message);
    return { status: "error", message: "Törn konnte nicht angelegt werden. Bitte erneut versuchen." };
  }

  await logAudit(supabase, {
    table_name: "trips",
    operation: "INSERT",
    record_id: trip.id,
    trip_id: trip.id,
    actor_person_id: auth.personId,
    payload: { ...trip, created_for_skipper_email: parsed.data.skipper_email || null },
  });

  // Skipper als erstes Crewmitglied dazuschreiben (mit is_skipper=TRUE).
  // Wenn der Admin sich selbst zum Skipper macht, ist skipperId === auth.personId.
  // Wenn der Trip für einen Freund angelegt wird, taucht der Admin nicht in
  // trip_members auf — er hat trotzdem Voll-Zugriff via ADMIN_EMAILS.
  await supabase.from("trip_members").insert({
    trip_id: trip.id,
    person_id: skipperId,
    is_skipper: true,
  });

  // Default-Kategorien anlegen (mit Emoji-Icon).
  await supabase.from("trip_categories").insert(
    DEFAULT_CATEGORIES.map((c, i) => ({
      trip_id: trip.id,
      name: c.name,
      icon: c.icon,
      sort_order: i + 1,
    })),
  );

  revalidatePath("/");
  redirect(`/trips/${trip.id}/settings`);
}

const DateUpdateSchema = z
  .object({
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: "Törn-Ende darf nicht vor dem Start liegen.",
    path: ["end_date"],
  });

export type DateUpdateState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

/**
 * Skipper/Admin darf das Start- und End-Datum eines Törns nachträglich
 * korrigieren — z. B. wenn der Törn verschoben oder verlängert wird.
 *
 * Hinweis: existierende Buchungen werden NICHT verschoben. Wer Buchungen
 * vor dem neuen Start-Datum hat, muss sie manuell anpassen. Anwesenheiten
 * in `trip_members.on_board_from/to` greifen weiter direkt.
 */
export async function updateTripDates(
  _prev: DateUpdateState,
  formData: FormData,
): Promise<DateUpdateState> {
  const tripId = formData.get("trip_id")?.toString() ?? "";
  if (!tripId) return { status: "error", message: "Törn-ID fehlt." };
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const parsed = DateUpdateSchema.safeParse({
    start_date: formData.get("start_date"),
    end_date: formData.get("end_date"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("trips")
    .update({
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
    })
    .eq("id", tripId);
  if (error) {
    console.error("[bordkasse:db]", error.message);
    return { status: "error", message: "Speichern fehlgeschlagen. Bitte erneut versuchen." };
  }

  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { start_date: parsed.data.start_date, end_date: parsed.data.end_date },
  });
  revalidatePath("/");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/settings`);
  return { status: "ok" };
}

export async function toggleArchive(tripId: string, archived: boolean) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trips").update({ archived }).eq("id", tripId);
  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { archived },
  });
  revalidatePath("/");
  revalidatePath(`/trips/${tripId}`);
}

/**
 * Manueller DSGVO-Purge eines einzelnen Trips — für Skipper/Admin, wenn
 * der automatische Cron mal nicht greift oder vor Ablauf der 30-Tage-Frist
 * gelöscht werden soll.
 *
 * Bei `force=false` (Default) gelten die normalen Cron-Bedingungen
 * (Retention-Frist + Settlement-Flag + alle Schulden bezahlt). Mit
 * `force=true` überspringt der Skipper Retention + Settlement, aber
 * NICHT die Schulden-Prüfung — sonst gingen offene Zahlungen verloren.
 */
export type PurgeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function purgeTripNow(tripId: string, force: boolean): Promise<PurgeResult> {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { ok: false, message: auth.message };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("purge_trip_data", {
    p_trip_id: tripId,
    p_force: force,
  });
  if (error) {
    console.error("[bordkasse:db]", error.message);
    return { ok: false, message: "Löschung fehlgeschlagen. Bitte erneut versuchen." };
  }
  const result = data as unknown as string;
  switch (result) {
    case "ok":
      await logAudit(supabase, {
        table_name: "trips",
        operation: "DELETE",
        record_id: tripId,
        trip_id: tripId,
        actor_person_id: auth.personId,
        payload: { manual_purge: true, forced: force },
      });
      revalidatePath("/");
      revalidatePath(`/trips/${tripId}`);
      revalidatePath(`/trips/${tripId}/settings`);
      return { ok: true, message: "Personenbezogene Daten gelöscht. Statistik bleibt anonymisiert erhalten." };
    case "not_found":
      return { ok: false, message: "Törn nicht gefunden." };
    case "already_purged":
      return { ok: false, message: "Daten dieses Törns wurden bereits gelöscht." };
    case "retention_not_reached":
      return { ok: false, message: 'Die 30-Tage-Frist nach Törn-Ende ist noch nicht erreicht. Mit „Sofort löschen“ überspringst du die Frist.' };
    case "settlement_not_announced":
      return { ok: false, message: "Bitte zuerst die Abrechnung verschicken. Danach kann gelöscht werden." };
    case "debts_open":
      return { ok: false, message: "Es gibt noch offene Schulden — alle Bezahlt-Häkchen müssen gesetzt sein, bevor gelöscht werden kann." };
    default:
      return { ok: false, message: `Unerwartete Antwort der Datenbank: ${result}` };
  }
}

export async function deleteTrip(tripId: string) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trips").delete().eq("id", tripId);
  await logAudit(supabase, {
    table_name: "trips",
    operation: "DELETE",
    record_id: tripId,
    trip_id: null,
    actor_person_id: auth.personId,
  });
  revalidatePath("/");
  redirect("/");
}
