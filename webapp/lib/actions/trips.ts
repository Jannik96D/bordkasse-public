"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireAdminOrTripCreator, requireSkipperOrAdmin, isAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { iconForCategoryName } from "@/lib/categories/icons";
import { displayNameFromEmail } from "@/lib/utils";
import { isSupportedCurrency } from "@/lib/rates/currencies";

// Reihenfolge bewusst gewählt — siehe `docs/categories.md` bzw. README.
// Crew-User-Feedback: zuerst die im Alltag häufigen (Lebensmittel, Restaurant),
// dann Hafen/Aktivitäten/Ausrüstung, dann Verbrauchs- + Verwaltungs-Sachen.
const DEFAULT_CATEGORY_NAMES_SAILING = [
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

// „Andere Reise": ohne segel-spezifische Kategorien (Yacht/Sprit/Hafen/
// Ausrüstung), dafür Unterkunft + Transport. Pro Reise frei editierbar.
const DEFAULT_CATEGORY_NAMES_OTHER = [
  "Lebensmittel",
  "Restaurant",
  "Unterkunft",
  "Aktivitäten",
  "Transport",
  "Versicherung",
  "Kaution",
  "Sonstiges",
] as const;

function defaultCategoriesFor(tripType: "sailing" | "other") {
  const names =
    tripType === "other" ? DEFAULT_CATEGORY_NAMES_OTHER : DEFAULT_CATEGORY_NAMES_SAILING;
  return names.map((name) => ({ name, icon: iconForCategoryName(name) }));
}

const TripSchema = z
  .object({
    name: z.string().trim().min(2, "Name muss mindestens 2 Zeichen haben.").max(80),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    ship_name: z.string().trim().max(80).optional().or(z.literal("")),
    // Segeltörn (Default) vs. „Andere Reise" — steuert das Wording und den
    // Ausschluss aus der Gesamtstatistik (siehe lib/trip-vocab.ts).
    trip_type: z.enum(["sailing", "other"]).default("sailing"),
    // Anzahlung vorgesehen („planned", Default) oder bewusst ohne („none").
    // „none" setzt trips.prepayment_declined_at → kein Anzahlungs-CTA auf der
    // Übersicht, kein „Anzahlungsplan anlegen"-Item in der Fortschritt-Karte.
    prepayment: z.enum(["planned", "none"]).default("planned"),
    // Wenn gesetzt, wird dieser User Skipper statt der Admin selbst —
    // damit der Admin Törns für andere anlegen kann ohne hinterher
    // wieder rausgeworfen werden zu müssen.
    skipper_email: z.string().trim().email("Ungültige Skipper-E-Mail.").optional().or(z.literal("")),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: "Törnende darf nicht vor dem Start liegen.",
    path: ["end_date"],
  });

export type TripState =
  | { status: "idle" }
  | { status: "error"; message: string };

export async function createTrip(_prev: TripState, formData: FormData): Promise<TripState> {
  const auth = await requireAdminOrTripCreator();
  if (!auth.ok) return { status: "error", message: auth.message };
  const callerIsAdmin = await isAdmin();

  const parsed = TripSchema.safeParse({
    name: formData.get("name"),
    start_date: formData.get("start_date"),
    end_date: formData.get("end_date"),
    ship_name: formData.get("ship_name") || "",
    trip_type: formData.get("trip_type") || "sailing",
    prepayment: formData.get("prepayment") || "planned",
    // Das Feld "für jemand anderen anlegen" ist nur Admins vorbehalten
    // (siehe new-trip-form.tsx) — nicht-Admin-Ersteller werden unten
    // unabhängig vom Formularinhalt immer selbst Skipper.
    skipper_email: callerIsAdmin ? formData.get("skipper_email") || "" : "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const supabase = createAdminClient();

  // Skipper bestimmen: wenn skipper_email angegeben ist (nur für Admins
  // möglich, s.o.), dort eine Person finden oder als Ghost anlegen —
  // sonst wird der Ersteller selbst Skipper. E-Mail-Lookup geht seit
  // Migration 0013 über persons_private.
  // Fund 9 (Code-Review 2026-08): `.eq` statt `.ilike` (CITEXT ist bereits
  // case-insensitiv; ilike brachte nur unbeabsichtigte Wildcards
  // (`%`/`_`) ins Spiel) + Fehler explizit geprüft — sonst hätte ein
  // DB-Fehler still den else-Zweig ausgelöst und (statt einer klaren
  // Meldung) einen rohen UNIQUE-Violation-Fehler beim persons_private-
  // Insert weiter unten produziert.
  let skipperId = auth.personId;
  if (parsed.data.skipper_email) {
    const email = parsed.data.skipper_email;
    const { data: existingPriv, error: lookupErr } = await supabase
      .from("persons_private")
      .select("person_id")
      .eq("email", email)
      .maybeSingle();
    if (lookupErr) {
      console.error("[bordkasse:db]", lookupErr.message);
      return { status: "error", message: "Skipper-E-Mail-Suche fehlgeschlagen. Bitte erneut versuchen." };
    }
    if (existingPriv) {
      skipperId = existingPriv.person_id;
    } else {
      const fallbackName = displayNameFromEmail(email);
      const { data: created, error: pErr } = await supabase
        .from("persons")
        .insert({ display_name: fallbackName })
        .select("id")
        .single();
      if (pErr || !created) {
        return { status: "error", message: pErr?.message ?? "Skipperperson konnte nicht angelegt werden." };
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
      trip_type: parsed.data.trip_type,
      prepayment_declined_at:
        parsed.data.prepayment === "none" ? new Date().toISOString() : null,
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

  // Default-Kategorien anlegen (typabhängig: Segeltörn vs. Andere Reise).
  await supabase.from("trip_categories").insert(
    defaultCategoriesFor(parsed.data.trip_type).map((c, i) => ({
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
    message: "Törnende darf nicht vor dem Start liegen.",
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
 * Reise-Typ umschalten (Segeltörn ↔ Andere Reise). Steuert Wording in der
 * Oberfläche und den Ausschluss aus der Gesamtstatistik. Nur Skipper/Admin.
 */
export async function updateTripType(tripId: string, tripType: "sailing" | "other") {
  if (tripType !== "sailing" && tripType !== "other") return;
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trips").update({ trip_type: tripType }).eq("id", tripId);
  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { trip_type: tripType },
  });
  revalidatePath("/");
  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/settings`);
}

/**
 * Entscheidung „Anzahlung vorgesehen / bewusst ohne" nachträglich ändern
 * (Settings-Sektion „Anzahlungsplan"). `declined=true` blendet den
 * Anzahlungs-CTA auf der Übersicht und das „Anzahlungsplan anlegen"-Item
 * der Fortschritt-Karte aus; ein existierender Plan gewinnt immer
 * (savePrepaymentPlan löscht das Flag beim Speichern).
 */
export async function setPrepaymentDeclined(tripId: string, declined: boolean) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase
    .from("trips")
    .update({ prepayment_declined_at: declined ? new Date().toISOString() : null })
    .eq("id", tripId);
  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { prepayment_declined: declined },
  });
  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/settings`);
}

/**
 * Fremdwährungen des Törns festlegen (Migration 0041). Leere Liste = reiner
 * Euro-Törn → in der Buchungsmaske erscheint kein Währungswähler. Nur die
 * kuratierten, vom Kurs-Anbieter abgedeckten Codes sind erlaubt. Nur
 * Skipper/Admin.
 */
export async function updateTripCurrencies(tripId: string, codes: string[]) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  // Nur unterstützte Codes, dedupliziert, stabile Reihenfolge egal.
  const clean = Array.from(new Set(codes.filter(isSupportedCurrency)));
  const supabase = createAdminClient();
  await supabase.from("trips").update({ foreign_currencies: clean }).eq("id", tripId);
  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { foreign_currencies: clean },
  });
  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/settings`);
  revalidatePath(`/trips/${tripId}/transactions/new`);
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
    case "too_young":
      return { ok: false, message: 'Die 30-Tage-Frist nach Törnende ist noch nicht erreicht. Mit „Sofort löschen“ überspringst du die Frist.' };
    case "no_settlement":
      return { ok: false, message: "Bitte zuerst die Abrechnung verschicken. Danach kann gelöscht werden." };
    case "debts_open":
      return { ok: false, message: "Es gibt noch offene Schulden: Alle Bezahlt-Häkchen müssen gesetzt sein, bevor gelöscht werden kann." };
    default:
      return { ok: false, message: `Unerwartete Antwort der Datenbank: ${result}` };
  }
}

/**
 * Admin schaltet für eine einzelne Person frei/aus, ob sie eigene Törns
 * anlegen darf (Migration 0045). Nur Admin — siehe app/admin/page.tsx.
 */
export async function setCanCreateTrips(
  personId: string,
  value: boolean,
): Promise<{ ok: boolean; message?: string }> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, message: auth.message };
  const supabase = createAdminClient();
  const { error } = await supabase.from("persons").update({ can_create_trips: value }).eq("id", personId);
  if (error) {
    console.error("[bordkasse:db]", error.message);
    return { ok: false, message: "Speichern fehlgeschlagen. Bitte erneut versuchen." };
  }
  await logAudit(supabase, {
    table_name: "persons",
    operation: "UPDATE",
    record_id: personId,
    trip_id: null,
    actor_person_id: auth.personId,
    payload: { can_create_trips: value },
  });
  revalidatePath("/admin");
  return { ok: true };
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
