"use server";

import { getCurrentPerson } from "@/lib/auth/get-current-person";

/**
 * Liefert NUR die UUID der eingeloggten Person (oder null) — für den
 * Personenwechsel-Wächter (`components/person-switch-guard.tsx`, Slice 12).
 * Bewusst keine weiteren Felder: der Wert landet im localStorage des Geräts.
 */
export async function getMyPersonId(): Promise<string | null> {
  const person = await getCurrentPerson();
  return person?.id ?? null;
}
