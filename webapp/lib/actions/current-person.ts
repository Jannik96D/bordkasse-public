"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import type { PersonProbe } from "@/lib/offline/person-switch";

/**
 * Liefert NUR die UUID der eingeloggten Person — für den Personenwechsel-
 * Wächter (`components/person-switch-guard.tsx`, Slice 12). Unterscheidet
 * bewusst „wirklich ausgeloggt“ (`none`, fehlende Session) von Auth-/Netz-
 * fehlern (`error`): Letzteres darf nie zum Löschen der Offline-Caches führen.
 */
export async function getMyPersonId(): Promise<PersonProbe> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      return error.name === "AuthSessionMissingError" ? { status: "none" } : { status: "error" };
    }
    if (!data.user) return { status: "none" };
    const person = await getCurrentPerson();
    return person ? { status: "person", id: person.id } : { status: "none" };
  } catch {
    return { status: "error" };
  }
}
