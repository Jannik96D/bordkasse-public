"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

const ProfileSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(2, "Name muss mindestens 2 Zeichen haben.")
    .max(60, "Name ist zu lang."),
  is_alcoholic: z.boolean(),
});

export type ProfileState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function updateProfile(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = ProfileSchema.safeParse({
    display_name: formData.get("display_name"),
    is_alcoholic: formData.get("is_alcoholic") === "on",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("persons")
    .update(parsed.data)
    .eq("id", person.id);

  if (error) return { status: "error", message: error.message };

  revalidatePath("/profile");
  return { status: "ok" };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
}
