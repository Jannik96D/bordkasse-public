"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
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

export type DeleteAccountState =
  | { status: "idle" }
  | { status: "error"; message: string };

/**
 * Selbst-Service-Kontolöschung (DSGVO Art. 17).
 *
 * Ruft die SQL-Function `delete_my_account()` (siehe Migration 0021) auf,
 * die alles Personen-bezogene anonymisiert/löscht. Anschließend wird die
 * `auth.users`-Row über die Admin-API gelöscht und der User auf die
 * Startseite umgeleitet — die Session-Cookies sind nach `deleteUser`
 * ungültig, der nächste Request-Roundtrip schickt ihn zum Login.
 *
 * Wenn der User in einem aktiven Trip Buchungen hat, wird die Löschung
 * abgewiesen — Bilanz würde sonst inkonsistent.
 */
export async function deleteMyAccount(
  _prev: DeleteAccountState,
  _formData: FormData,
): Promise<DeleteAccountState> {
  const person = await getCurrentPerson();
  if (!person?.auth_user_id) {
    return { status: "error", message: "Nicht angemeldet." };
  }

  const admin = createAdminClient();

  const { data: result, error: rpcErr } = await admin.rpc("delete_my_account");
  if (rpcErr) {
    console.error("[bordkasse:self-delete]", rpcErr.message);
    return {
      status: "error",
      message: "Konto konnte nicht gelöscht werden. Bitte später erneut versuchen.",
    };
  }

  if (result === "has_active_bookings") {
    return {
      status: "error",
      message:
        "Du hast noch Buchungen in einem aktiven Törn. Bitte warte bis nach dem Törn-Ende oder lass deine Buchungen vorher vom Skipper umbuchen.",
    };
  }
  if (result === "not_authenticated") {
    return { status: "error", message: "Nicht angemeldet." };
  }
  if (result !== "ok") {
    return {
      status: "error",
      message: `Unerwartete Antwort: ${result}. Bitte später erneut versuchen.`,
    };
  }

  // Auth-User physisch entfernen — Magic-Link-Login geht danach nicht mehr.
  const { error: authErr } = await admin.auth.admin.deleteUser(person.auth_user_id);
  if (authErr) {
    console.error("[bordkasse:self-delete:auth]", authErr.message);
    // Personen-Anonymisierung hat geklappt, aber Auth-User hängt — der User
    // sieht den Fehler nicht (zu spät), aber Admin sollte das wegputzen.
  }

  const cookieClient = await createClient();
  await cookieClient.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/?account_deleted=1");
}
