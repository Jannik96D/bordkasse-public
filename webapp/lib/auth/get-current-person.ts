import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Liefert die persons-Row des aktuell eingeloggten Users.
 *
 * Beim ersten Login wird automatisch eine persons-Row angelegt
 * (bzw. eine vorhandene Ghost-Row mit passender E-Mail verlinkt).
 *
 * Auth wird über den Cookie-Client (auth.getUser) verifiziert. Schreib-
 * Zugriffe auf persons laufen über den Admin-Client — siehe
 * lib/supabase/admin.ts (Workaround für Auth-Cookie-Propagation in
 * Next.js 16 Server Actions).
 *
 * Returns null wenn nicht eingeloggt.
 */
export async function getCurrentPerson() {
  const cookieClient = await createClient();
  const { data: { user } } = await cookieClient.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();

  // 1. Schon verlinkt?
  const { data: linked } = await admin
    .from("persons")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (linked) return linked;

  // 2. Ghost-Person mit passender E-Mail vorhanden? → verlinken
  if (user.email) {
    const { data: ghost } = await admin
      .from("persons")
      .select("*")
      .ilike("email", user.email)
      .is("auth_user_id", null)
      .maybeSingle();

    if (ghost) {
      const { data: updated, error } = await admin
        .from("persons")
        .update({ auth_user_id: user.id })
        .eq("id", ghost.id)
        .select()
        .single();
      if (!error && updated) return updated;
    }
  }

  // 3. Neue Person anlegen
  const displayName =
    (user.user_metadata?.display_name as string | undefined) ??
    user.email?.split("@")[0] ??
    "Unbekannt";

  const { data: created, error } = await admin
    .from("persons")
    .insert({
      auth_user_id: user.id,
      email: user.email,
      display_name: displayName,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to create person row:", error);
    return null;
  }
  return created;
}
