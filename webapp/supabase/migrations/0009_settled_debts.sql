-- ═══════════════════════════════════════════════════════════════════════
-- 0009_settled_debts — Bezahlt-Markierungen für Schulden im Trip
--
-- Bislang lag das "Erledigt"-Häkchen pro Schulden-Zeile nur im localStorage
-- des Crew-Mitglieds — jeder sah seine eigenen Markierungen, niemand die
-- der anderen.
-- Neu: settled_debts speichert die Markierung trip-übergreifend in der DB,
-- mit Realtime-Sync, sodass das Häkchen für alle Crew-Mitglieder gleich
-- aussieht. Schlüssel ist (trip_id, from_person_id, to_person_id, amount):
-- wenn sich der Betrag durch eine neue Buchung ändert, ist es eine "neue"
-- Schuld und logisch nicht mehr erledigt.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE settled_debts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id               UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_person_id        UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  to_person_id          UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  amount                NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  settled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_by_person_id  UUID REFERENCES persons(id) ON DELETE SET NULL,

  CONSTRAINT settled_debts_unique UNIQUE (trip_id, from_person_id, to_person_id, amount),
  CONSTRAINT settled_debts_distinct CHECK (from_person_id <> to_person_id)
);

CREATE INDEX idx_settled_debts_trip ON settled_debts(trip_id);

ALTER TABLE settled_debts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "settled_debts_select_member"
  ON settled_debts FOR SELECT
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

-- Schreibrechte über App-Layer (Service-Role-Client + requireMember).
-- Direkter Insert/Delete via authenticated bleibt geschlossen — die
-- Markierung läuft ausschließlich über Server Actions.

ALTER PUBLICATION supabase_realtime ADD TABLE settled_debts;
