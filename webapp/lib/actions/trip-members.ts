"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipper } from "@/lib/auth/authz";

const InviteSchema = z.object({
  trip_id: z.string().uuid(),
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben."),
  display_name: z.string().trim().min(2).max(60).optional().or(z.literal("")),
  on_board_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  on_board_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  is_alcoholic: z.string().optional(),
  note: z.string().max(200).optional().or(z.literal("")),
});

export type MemberState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function inviteMember(_prev: MemberState, formData: FormData): Promise<MemberState> {
  const parsed = InviteSchema.safeParse({
    trip_id: formData.get("trip_id"),
    email: formData.get("email"),
    display_name: formData.get("display_name") || "",
    on_board_from: formData.get("on_board_from") || "",
    on_board_to: formData.get("on_board_to") || "",
    is_alcoholic: formData.get("is_alcoholic")?.toString(),
    note: formData.get("note") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const { trip_id, email, display_name, on_board_from, on_board_to, is_alcoholic, note } = parsed.data;

  const auth = await requireSkipper(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  // Person mit dieser E-Mail finden oder als Ghost anlegen
  const { data: existing } = await supabase
    .from("persons")
    .select("id, display_name")
    .ilike("email", email)
    .maybeSingle();

  let personId: string;
  if (existing) {
    personId = existing.id;
    // Bestehender Name bleibt — wir überschreiben fremde Namen nicht.
  } else {
    const fallbackName = display_name || email.split("@")[0];
    const { data: created, error } = await supabase
      .from("persons")
      .insert({ email, display_name: fallbackName })
      .select("id")
      .single();
    if (error || !created) {
      return { status: "error", message: error?.message ?? "Person konnte nicht angelegt werden." };
    }
    personId = created.id;
  }

  // Mitgliedschaft anlegen (UPSERT auf trip_id+person_id)
  const alkInput = is_alcoholic;
  const isAlcoholic =
    alkInput === "yes" ? true :
    alkInput === "no" ? false :
    null;

  const { error: tmError } = await supabase
    .from("trip_members")
    .upsert(
      {
        trip_id,
        person_id: personId,
        on_board_from: on_board_from || null,
        on_board_to: on_board_to || null,
        is_alcoholic: isAlcoholic,
        note: note || null,
      },
      { onConflict: "trip_id,person_id" },
    );

  if (tmError) return { status: "error", message: tmError.message };

  revalidatePath(`/trips/${trip_id}/settings`);
  revalidatePath(`/trips/${trip_id}`);
  return { status: "ok" };
}

export async function removeMember(memberId: string, tripId: string) {
  const auth = await requireSkipper(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trip_members").delete().eq("id", memberId);
  revalidatePath(`/trips/${tripId}/settings`);
  revalidatePath(`/trips/${tripId}`);
}
