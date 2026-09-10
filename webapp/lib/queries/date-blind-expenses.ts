import { readClient } from "@/lib/supabase/read-client";

/**
 * Zählt die Bordkasse-Buchungen eines Törns, deren Aufteilung KEINE
 * Anwesenheit kennt — sie sind der einzige Fall, den ein Crewwechsel mitten
 * im Törn (Variante b) nicht sauber abbilden kann.
 *
 * Betroffen laut `v_transaction_shares` (0031) und `v_balances` (0043):
 *   • `split_type = 'equal'` — aktives Set ist schlicht `TRUE`, also ALLE
 *     `trip_members`, ohne jeden Datumsbezug.
 *   • `split_type = 'time_proportional'` — aktives Set ist `days > 0`, der
 *     Anteil `amount * days / active_days`; das Buchungsdatum kommt in der
 *     Formel nicht vor.
 *   • Gutschriften „An Alle" (`credit_to_all`) — `credit_received_alle`
 *     verteilt auf alle Crew, `/(n-1)`, ebenfalls datumslos.
 *
 * Der Effekt geht in BEIDE Richtungen und ist deshalb bewusst nicht auf
 * Buchungen vor dem Wechseltag eingeschränkt:
 *   • rückwärts — der Nachrücker zahlt an Ausgaben von VOR seiner Ankunft mit
 *     (gemessen: 400 € „gleichmäßig" bei 4 Personen = je 100 €; nach dem
 *     Wechsel 5 Zeilen = je 80 €, Nachrücker inklusive);
 *   • vorwärts — die abgereiste Person bleibt Crewmitglied und zahlt bei
 *     `equal` einen VOLLEN Anteil an jeder Ausgabe NACH ihrer Abreise mit.
 *
 * `on_board`, `individual` und `per_person` sind sauber und werden nicht
 * gezählt. Das Crewwechsel-Formular zeigt die Zahl als Warnung; der Skipper
 * kann die Buchungen vorher auf „An Bord" umstellen. Bewusst keine
 * automatische Umschreibung — das wäre eine irreversible Änderung an
 * fremden Buchungen.
 *
 * Eigene Datei statt `lib/queries/trips.ts`: ein neuer Export dort blieb im
 * Turbopack-Modulgraph zur Laufzeit `undefined` (`ReferenceError`, auch nach
 * `.next`-Wipe) — vermutlich weil aus derselben Datei `TripMemberRow` per
 * `import type` in eine Client-Komponente gezogen wird.
 */
export async function countPresenceBlindBookings(tripId: string): Promise<number> {
  const supabase = await readClient();
  // Bewusst zwei vollständig ausgeschriebene Queries statt eines geteilten
  // Basis-Builders: die Supabase-Builder sind mutierbar, ein gemeinsamer
  // Ausgangspunkt würde beim nächsten Filter still in beide Zweige lecken.
  const [expenses, creditsToAll] = await Promise.all([
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("type", "expense")
      .in("split_type", ["equal", "time_proportional"])
      .is("tranche_id", null)
      .is("deleted_at", null),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("type", "credit")
      .eq("credit_to_all", true)
      .is("tranche_id", null)
      .is("deleted_at", null),
  ]);
  // Fehler bewusst als 0 behandeln: die Warnung ist ein Hinweis, kein Guard —
  // eine Fehlerseite auf der Einstellungsseite wäre die schlechtere Antwort.
  return (expenses.count ?? 0) + (creditsToAll.count ?? 0);
}
