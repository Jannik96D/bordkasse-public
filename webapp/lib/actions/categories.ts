"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import {
  CATEGORY_ICON_NAMES,
  iconForCategoryName,
  isCategoryIconName,
  type CategoryIconName,
} from "@/lib/categories/icons";

const AddCatSchema = z.object({
  trip_id: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  icon: z.string().trim().max(40).optional().or(z.literal("")),
});

const SetIconSchema = z.object({
  category_id: z.string().uuid(),
  trip_id: z.string().uuid(),
  icon: z.enum(CATEGORY_ICON_NAMES),
});

export type CatState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function addCategory(_prev: CatState, formData: FormData): Promise<CatState> {
  const parsed = AddCatSchema.safeParse({
    trip_id: formData.get("trip_id"),
    name: formData.get("name"),
    icon: formData.get("icon") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const auth = await requireSkipperOrAdmin(parsed.data.trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const icon: CategoryIconName = isCategoryIconName(parsed.data.icon)
    ? parsed.data.icon
    : iconForCategoryName(parsed.data.name);

  const supabase = createAdminClient();
  const { data: cat, error } = await supabase
    .from("trip_categories")
    .insert({
      trip_id: parsed.data.trip_id,
      name: parsed.data.name,
      icon,
      sort_order: 99,
    })
    .select()
    .single();
  if (error || !cat) return { status: "error", message: error?.message ?? "Konnte nicht angelegt werden." };

  await logAudit(supabase, {
    table_name: "trip_categories",
    operation: "INSERT",
    record_id: cat.id,
    trip_id: parsed.data.trip_id,
    actor_person_id: auth.personId,
    payload: cat,
  });

  revalidatePath(`/trips/${parsed.data.trip_id}/settings`);
  return { status: "ok" };
}

export async function removeCategory(categoryId: string, tripId: string) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase.from("trip_categories").delete().eq("id", categoryId);
  await logAudit(supabase, {
    table_name: "trip_categories",
    operation: "DELETE",
    record_id: categoryId,
    trip_id: tripId,
    actor_person_id: auth.personId,
  });
  revalidatePath(`/trips/${tripId}/settings`);
}

export async function setCategoryIcon(
  categoryId: string,
  iconName: CategoryIconName,
  tripId: string,
): Promise<{ ok: boolean; message?: string }> {
  const parsed = SetIconSchema.safeParse({
    category_id: categoryId,
    trip_id: tripId,
    icon: iconName,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültiges Icon." };
  }

  const auth = await requireSkipperOrAdmin(parsed.data.trip_id);
  if (!auth.ok) return { ok: false, message: auth.message };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("trip_categories")
    .update({ icon: parsed.data.icon })
    .eq("id", parsed.data.category_id);
  if (error) return { ok: false, message: error.message };

  await logAudit(supabase, {
    table_name: "trip_categories",
    operation: "UPDATE",
    record_id: parsed.data.category_id,
    trip_id: parsed.data.trip_id,
    actor_person_id: auth.personId,
    payload: { icon: parsed.data.icon },
  });

  revalidatePath(`/trips/${parsed.data.trip_id}/settings`);
  return { ok: true };
}
