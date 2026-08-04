import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface CurrentPerson {
  id: string;
  display_name: string;
  is_alcoholic: boolean;
  auth_user_id: string | null;
  created_at: string;
  /** Eigene E-Mail aus persons_private. Self-Read via RLS. */
  email: string | null;
  /** Von einem Admin freigeschaltet: darf eigene Törns anlegen (Migration 0045). */
  can_create_trips: boolean;
}

/**
 * Liefert die persons-Row des aktuell eingeloggten Users — angereichert
 * um die eigene E-Mail aus persons_private (Self darf die eigene private
 * Row lesen).
 *
 * Beim ersten Login wird automatisch eine persons-Row + persons_private-
 * Row angelegt (bzw. eine vorhandene Ghost-Row mit passender E-Mail
 * verlinkt).
 *
 * Auth wird über den Cookie-Client (auth.getUser) verifiziert. Schreib-
 * Zugriffe laufen über den Admin-Client — siehe lib/supabase/admin.ts
 * (Workaround für Auth-Cookie-Propagation in Next.js 16 Server Actions).
 *
 * Returns null wenn nicht eingeloggt.
 *
 * Mit React `cache()` pro Request memoisiert: die teure Auth-Auflösung
 * (`auth.getUser()` = Netz-Call + persons/persons_private-Queries) läuft
 * pro Server-Render genau EINMAL, egal wie oft sie über readClient/isAdmin/
 * Seiten-Queries angefragt wird. Nebeneffekt: schließt eine Race beim
 * Erst-Login aus (mehrfaches paralleles Anlegen derselben persons-Row).
 */
export const getCurrentPerson = cache(async (): Promise<CurrentPerson | null> => {
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
  if (linked) {
    const { data: priv } = await admin
      .from("persons_private")
      .select("email")
      .eq("person_id", linked.id)
      .maybeSingle();
    return { ...linked, email: priv?.email ?? null } as CurrentPerson;
  }

  // 2. Ghost-Person mit passender E-Mail vorhanden? → verlinken
  //
  // Fund 9 (Code-Review 2026-08): `.eq` statt `.ilike` — die Spalte ist
  // bereits CITEXT (case-insensitiv), `ilike` brachte nur Wildcards
  // (`%`/`_`) ins Spiel. Mit `_` als Ein-Zeichen-Joker hätte sich sonst ein
  // frisch eingeloggter Auth-User mit einer E-Mail wie `max_mueller@…`
  // (Länge/Domain identisch zu `max.mueller@…`) mit der FREMDEN Ghost-Person
  // verlinken lassen und deren Törn-Mitgliedschaften übernommen — bei genau
  // einem Treffer griff sogar der Fail-Safe unten (mehrere Treffer →
  // Fehler) nicht. `eq` + die UNIQUE-Constraint auf persons_private.email
  // schließen mehrdeutige Treffer strukturell aus.
  //
  // Fehler wird jetzt explizit geprüft und fail-closed behandelt (statt
  // still als "kein Ghost gefunden" durchzureichen) — sonst hätte ein
  // transienter DB-Fehler zur Neuanlage einer zusätzlichen Person geführt,
  // während der eigentliche Ghost unverlinkt liegen bleibt.
  if (user.email) {
    const { data: ghostPriv, error: ghostPrivErr } = await admin
      .from("persons_private")
      .select("person_id, email")
      .eq("email", user.email)
      .maybeSingle();
    if (ghostPrivErr) {
      console.error("[bordkasse:get-current-person] Ghost-Lookup fehlgeschlagen:", ghostPrivErr.message);
      return null;
    }

    if (ghostPriv) {
      const { data: ghost } = await admin
        .from("persons")
        .select("*")
        .eq("id", ghostPriv.person_id)
        .is("auth_user_id", null)
        .maybeSingle();

      if (ghost) {
        const { data: updated, error } = await admin
          .from("persons")
          .update({ auth_user_id: user.id })
          .eq("id", ghost.id)
          .select()
          .single();
        if (!error && updated) {
          return { ...updated, email: ghostPriv.email } as CurrentPerson;
        }
      }
    }
  }

  // 3. Neue Person anlegen (persons + persons_private)
  const displayName =
    (user.user_metadata?.display_name as string | undefined) ??
    user.email?.split("@")[0] ??
    "Unbekannt";

  const { data: created, error } = await admin
    .from("persons")
    .insert({
      auth_user_id: user.id,
      display_name: displayName,
    })
    .select()
    .single();

  if (error || !created) {
    console.error("Failed to create person row:", error);
    return null;
  }

  if (user.email) {
    const { error: privErr } = await admin
      .from("persons_private")
      .insert({ person_id: created.id, email: user.email });
    if (privErr) {
      console.error("Failed to create persons_private row:", privErr);
      // persons-Row bleibt bestehen — bei nächstem Login versucht's der Code
      // noch mal über den Ghost-Pfad.
    }
  }

  return { ...created, email: user.email ?? null } as CurrentPerson;
});
