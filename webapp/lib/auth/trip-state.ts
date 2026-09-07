import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Nutzer-facing Fehlermeldung, wenn eine Schreib-Aktion an einem archivierten
 * Törn versucht wird. Zentral hier definiert (statt pro Call-Site dupliziert),
 * damit Wording + Test-Assertions an EINER Stelle bleiben.
 */
export const ARCHIVED_TRIP_MSG =
  "Dieser Törn ist archiviert. Bitte zuerst in den Einstellungen „Aus Archiv holen“, um Änderungen vorzunehmen.";

/**
 * Schreibschutz für archivierte Törns (Sanierungsplan D3).
 *
 * `trips.archived` (Migration 0001) war bisher rein kosmetisch — es steuerte
 * nur, in welcher Sektion ein Törn auf der Trip-Übersicht erscheint, OHNE
 * jeden Schreibschutz. Diese Funktion macht das Flag hart: jede Schreib-
 * Aktion (Buchungen, Crew, Anzahlungen, Kategorien) muss NACH dem jeweiligen
 * Auth-Guard (requireMember/requireSkipper/…) zusätzlich hier prüfen, ob der
 * Törn archiviert ist, und bei `archived = true` mit einer klaren Meldung
 * abbrechen, statt still zu schreiben.
 *
 * BEWUSST NICHT in die bestehenden Auth-Guards (requireMember & Co.)
 * eingebaut: diese werden auch von reinen LESE-Pfaden genutzt (z. B.
 * Settlement-Anzeige, Checklisten-Read, Trip-Settings-Änderungen außerhalb
 * des hier geschützten Scopes) — eine globale Erweiterung hätte dort
 * unbeabsichtigt Lesezugriffe oder außerhalb des Sanierungsplans liegende
 * Schreibpfade mitgesperrt. Stattdessen wird der Check gezielt in jeder
 * betroffenen Funktion aufgerufen (siehe transactions.ts, trip-members.ts,
 * prepayments.ts, categories.ts).
 *
 * `toggleArchive` selbst (lib/actions/trips.ts) ruft diese Funktion bewusst
 * NICHT auf — sonst gäbe es aus dem Archiv-Zustand keinen Ausweg mehr.
 */
export async function assertTripNotArchived(
  supabase: AdminClient,
  tripId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data } = await supabase
    .from("trips")
    .select("archived")
    .eq("id", tripId)
    .maybeSingle();
  if (data?.archived) {
    return { ok: false, message: ARCHIVED_TRIP_MSG };
  }
  return { ok: true };
}
