import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * „Die Salden dieses Törns können sich geändert haben."
 *
 * Ruft `mark_post_settlement_change` (Migration 0019): setzt
 * `trips.changes_pending_since` auf NOW, sofern die Abrechnung schon
 * verschickt wurde und noch kein offener Änderungs-Hinweis vorliegt. Damit
 * sieht die Crew den „Bilanz hat sich seit der Abrechnung geändert"-Banner
 * und kann eine Update-Mail nachschieben (`resendSettlement`). Vor der
 * Abrechnung ist der Aufruf ein No-op.
 *
 * Wer muss das rufen? JEDER Pfad, der nach einem erfolgreichen Write die
 * Bilanz verschieben kann — nicht nur Buchungen. `v_transaction_shares`
 * leitet „Gleichmäßig"/„An Bord"/„Zeitanteilig"/„An Alle" allein aus
 * `trip_members` (+ Törndatum) ab, den Alkoholanteil aus dem Trinker-Flag.
 * Deshalb auch: Crew hinzufügen/entfernen, Anwesenheit/Trinker-Flag ändern,
 * Törndatum ändern (Sicherheitsrunde 2026-11, Slice 9). Ohne den Marker
 * würden abgehakte Schulden still entwertet, ohne dass jemand es merkt.
 *
 * Erst NACH dem erfolgreichen Write aufrufen. Ein Fehler des Markers rollt
 * den Write nicht zurück (er ist bereits geschehen) — er wird nur geloggt.
 * Wirft nie (auch nicht bei einem unerwarteten Client-Fehler).
 */
export async function markBalancesMayHaveChanged(
  supabase: Pick<SupabaseClient, "rpc">,
  tripId: string,
): Promise<void> {
  try {
    const { error } = await supabase.rpc("mark_post_settlement_change", { p_trip_id: tripId });
    if (error) console.error("[bordkasse:settlement-resend]", error.message);
  } catch (e) {
    console.error("[bordkasse:settlement-resend]", e);
  }
}
