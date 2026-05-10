"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipper } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";

const DEFAULT_CATEGORIES = [
  "Lebensmittel",
  "Restaurant",
  "Sprit",
  "Yacht",
  "Hafen / Liegeplatz",
  "Ausrüstung",
  "Sonstiges",
];

const TripSchema = z
  .object({
    name: z.string().trim().min(2, "Name muss mindestens 2 Zeichen haben.").max(80),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
    ship_name: z.string().trim().max(80).optional().or(z.literal("")),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: "Törn-Ende darf nicht vor dem Start liegen.",
    path: ["end_date"],
  });

export type TripState =
  | { status: "idle" }
  | { status: "error"; message: string };

export async function createTrip(_prev: TripState, formData: FormData): Promise<TripState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = TripSchema.safeParse({
    name: formData.get("name"),
    start_date: formData.get("start_date"),
    end_date: formData.get("end_date"),
    ship_name: formData.get("ship_name") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const supabase = createAdminClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .insert({
      name: parsed.data.name,
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
      ship_name: parsed.data.ship_name || null,
      skipper_id: person.id,
    })
    .select()
    .single();

  if (error || !trip) {
    return { status: "error", message: error?.message ?? "Trip konnte nicht angelegt werden." };
  }

  await logAudit(supabase, {
    table_name: "trips",
    operation: "INSERT",
    record_id: trip.id,
    trip_id: trip.id,
    actor_person_id: person.id,
    payload: trip,
  });

  // Skipper als erstes Crew-Mitglied dazuschreiben
  await supabase.from("trip_members").insert({
    trip_id: trip.id,
    person_id: person.id,
  });

  // Default-Kategorien anlegen
  await supabase.from("trip_categories").insert(
    DEFAULT_CATEGORIES.map((name, i) => ({
      trip_id: trip.id,
      name,
      sort_order: i + 1,
    })),
  );

  revalidatePath("/");
  redirect(`/trips/${trip.id}/settings`);
}

export async function toggleArchive(tripId: string, archived: boolean) {
  const auth = await requireSkipper(tripId);
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

export async function deleteTrip(tripId: string) {
  const auth = await requireSkipper(tripId);
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
