/**
 * „Zuletzt informiert am …" für den Knopf „Crew informieren" (PR6,
 * Migration 0062). Bewusst eine EIGENE Query statt einer zusätzlichen Spalte
 * in getPlan/getItems: fehlt die Migration (App vor Migration), scheitert nur
 * diese Abfrage — fail-soft, die Anzeige entfällt. In getItems würde eine
 * unbekannte Spalte die ganze Anzahlungs-Seite in die Error-Boundary werfen.
 */

import { cache } from "react";
import { readClient } from "@/lib/supabase/read-client";

export interface CrewNotifyState {
  planLastNotifiedAt: string | null;
  itemLastNotifiedAt: Record<string, string>;
}

export const getCrewNotifyState = cache(async (tripId: string): Promise<CrewNotifyState> => {
  const state: CrewNotifyState = { planLastNotifiedAt: null, itemLastNotifiedAt: {} };
  try {
    const supabase = await readClient();
    const [planRes, itemsRes] = await Promise.all([
      supabase.from("prepayment_plan").select("crew_last_notified_at").eq("trip_id", tripId).maybeSingle(),
      supabase.from("prepayment_items").select("id, crew_last_notified_at").eq("trip_id", tripId),
    ]);
    if (planRes.error) console.error("[bordkasse:crew-notify]", planRes.error.message);
    else state.planLastNotifiedAt = (planRes.data?.crew_last_notified_at as string | null | undefined) ?? null;
    if (itemsRes.error) console.error("[bordkasse:crew-notify]", itemsRes.error.message);
    else {
      for (const r of itemsRes.data ?? []) {
        if (r.crew_last_notified_at) state.itemLastNotifiedAt[r.id as string] = r.crew_last_notified_at as string;
      }
    }
  } catch (err) {
    console.error("[bordkasse:crew-notify]", err instanceof Error ? err.message : String(err));
  }
  return state;
});
