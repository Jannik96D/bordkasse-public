"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipper } from "@/lib/auth/authz";

const AddCatSchema = z.object({
  trip_id: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
});

export type CatState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function addCategory(_prev: CatState, formData: FormData): Promise<CatState> {
  const parsed = AddCatSchema.safeParse({
    trip_id: formData.get("trip_id"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const auth = await requireSkipper(parsed.data.trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("trip_categories")
    .insert({ trip_id: parsed.data.trip_id, name: parsed.data.name, sort_order: 99 });
  if (error) return { status: "error", message: error.message };

  revalidatePath(`/trips/${parsed.data.trip_id}/settings`);
  return { status: "ok" };
}

export async function removeCategory(categoryId: string, tripId: string) {
  const auth = await requireSkipper(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trip_categories").delete().eq("id", categoryId);
  revalidatePath(`/trips/${tripId}/settings`);
}
