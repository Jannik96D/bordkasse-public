import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAdminEmails } from "@/lib/auth/admin-emails";
import { authAnchorOf } from "@/lib/auth/ensure-auth-user";

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
 * Beim ersten Login wird eine vorhandene Ghost-Row mit passender E-Mail
 * verlinkt — aber nur, wenn das Auth-Konto den serverseitigen Anker
 * `app_metadata.bordkasse_email` für genau diese Adresse trägt
 * (Sicherheitsrunde 2026-11, Slice 1, siehe lib/auth/ensure-auth-user.ts).
 * Eine NEUE Person wird nur für Adressen aus ADMIN_EMAILS angelegt (Erst-
 * Login eines Admins ohne Einladung); jedes andere Konto ohne Person
 * bekommt `null`.
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

  // Ab hier ist das Konto noch mit keiner Person verknüpft. `user.email` ist
  // über GoTrue änderbar (PUT /auth/v1/user, mit Autoconfirm ohne
  // Bestätigung) und damit allein KEIN Identitätsnachweis. Vertraut wird ihr
  // nur, wenn der serverseitige Anker (nur per Service-Role schreibbar, von
  // ensureAuthUser beim Login/bei der Einladung gesetzt) auf genau diese
  // Adresse zeigt. Ohne passenden Anker: weder Ghost-Link noch Neuanlage.
  const userEmail = user.email?.trim().toLowerCase() ?? "";
  const anchor = authAnchorOf(user.app_metadata);
  if (!userEmail || !anchor || anchor !== userEmail) return null;

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
  {
    const { data: ghostPriv, error: ghostPrivErr } = await admin
      .from("persons_private")
      .select("person_id, email")
      .eq("email", userEmail)
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
          // Absicherung gegen parallele Verknüpfung: nur, solange noch frei.
          .is("auth_user_id", null)
          .select()
          .single();
        if (!error && updated) {
          return { ...updated, email: ghostPriv.email } as CurrentPerson;
        }
      }
      // Paralleler Request desselben Kontos war schneller (beide sahen die
      // Person frei, nur einer konnte verknüpfen) → Schritt 1 nachholen.
      const { data: relinked } = await admin
        .from("persons")
        .select("*")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (relinked) return { ...relinked, email: ghostPriv.email } as CurrentPerson;
      // Adresse gehört einer Person, die schon mit einem ANDEREN Konto
      // verknüpft ist (oder das Verknüpfen schlug fehl) — keine Neuanlage,
      // die würde ohnehin an der UNIQUE-Constraint der E-Mail scheitern.
      return null;
    }
  }

  // 3. Neue Person anlegen (persons + persons_private) — NUR für Adressen aus
  // ADMIN_EMAILS (Erst-Login eines Admins ohne Einladung, der einzige
  // legitime Fall). Vorher bekam JEDES Konto hier eine Person, also auch
  // eines, das jemand am App-Login vorbei direkt bei GoTrue angelegt hat.
  if (!getAdminEmails().includes(userEmail)) return null;

  const displayName =
    (user.user_metadata?.display_name as string | undefined) ??
    userEmail.split("@")[0] ??
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

  const { error: privErr } = await admin
    .from("persons_private")
    .insert({ person_id: created.id, email: userEmail });
  if (privErr) {
    // Früher wurde hier trotzdem `email: user.email` zurückgegeben — damit
    // war `isAdmin` im ersten Request wahr, obwohl die Adresse nirgends
    // gespeichert war. Jetzt: null, und die eben angelegte persons-Zeile
    // wird kompensierend gelöscht, damit der nächste Request sauber neu
    // ansetzt statt an einer Person ohne E-Mail festzuhängen.
    console.error("[bordkasse:get-current-person] persons_private-Insert fehlgeschlagen:", privErr.code ?? "unknown");
    const { error: delErr } = await admin.from("persons").delete().eq("id", created.id);
    if (delErr) {
      console.error("[bordkasse:get-current-person] Kompensation fehlgeschlagen:", delErr.code ?? "unknown");
    }
    return null;
  }

  return { ...created, email: userEmail } as CurrentPerson;
});
