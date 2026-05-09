-- ═══════════════════════════════════════════════════════════════════════
-- 0004_rls — Row Level Security Policies
--
-- Grundregel: Jede authentifizierte Person sieht nur Trips, in denen sie
-- als Skipper oder Mitglied verzeichnet ist. CRUD nur für Skipper.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE persons                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_members               ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_participants   ENABLE ROW LEVEL SECURITY;


-- ── persons ────────────────────────────────────────────────────────────
-- Alle eingeloggten User können alle Personen lesen (für Crew-Auswahl in
-- UI). Schreiben darf jede Person nur ihre eigene Row.
CREATE POLICY "persons_select_authenticated"
  ON persons FOR SELECT
  TO authenticated
  USING (TRUE);

CREATE POLICY "persons_insert_self"
  ON persons FOR INSERT
  TO authenticated
  WITH CHECK (auth_user_id = auth.uid() OR auth_user_id IS NULL);

CREATE POLICY "persons_update_self"
  ON persons FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());


-- ── trips ──────────────────────────────────────────────────────────────
CREATE POLICY "trips_select_member"
  ON trips FOR SELECT
  TO authenticated
  USING (is_trip_member(id) OR is_trip_skipper(id));

CREATE POLICY "trips_insert_self"
  ON trips FOR INSERT
  TO authenticated
  WITH CHECK (skipper_id = current_person_id());

CREATE POLICY "trips_update_skipper"
  ON trips FOR UPDATE
  TO authenticated
  USING (is_trip_skipper(id))
  WITH CHECK (is_trip_skipper(id));

CREATE POLICY "trips_delete_skipper"
  ON trips FOR DELETE
  TO authenticated
  USING (is_trip_skipper(id));


-- ── trip_members ───────────────────────────────────────────────────────
CREATE POLICY "tm_select_member"
  ON trip_members FOR SELECT
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tm_insert_skipper"
  ON trip_members FOR INSERT
  TO authenticated
  WITH CHECK (is_trip_skipper(trip_id));

CREATE POLICY "tm_update_skipper_or_self"
  ON trip_members FOR UPDATE
  TO authenticated
  USING (is_trip_skipper(trip_id) OR person_id = current_person_id())
  WITH CHECK (is_trip_skipper(trip_id) OR person_id = current_person_id());

CREATE POLICY "tm_delete_skipper"
  ON trip_members FOR DELETE
  TO authenticated
  USING (is_trip_skipper(trip_id));


-- ── trip_categories ────────────────────────────────────────────────────
CREATE POLICY "tc_select_member"
  ON trip_categories FOR SELECT
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tc_cud_skipper"
  ON trip_categories FOR ALL
  TO authenticated
  USING (is_trip_skipper(trip_id))
  WITH CHECK (is_trip_skipper(trip_id));


-- ── transactions ───────────────────────────────────────────────────────
-- Alle Mitglieder dürfen Transaktionen lesen UND erfassen UND ändern.
-- (Bordkasse = gemeinsame Kasse — jede Crew hat Schreibrecht.)
CREATE POLICY "tx_select_member"
  ON transactions FOR SELECT
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tx_insert_member"
  ON transactions FOR INSERT
  TO authenticated
  WITH CHECK (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tx_update_member"
  ON transactions FOR UPDATE
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id))
  WITH CHECK (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tx_delete_member"
  ON transactions FOR DELETE
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));


-- ── transaction_participants ───────────────────────────────────────────
-- Wer die Transaktion bearbeiten darf, darf auch Participants ändern.
CREATE POLICY "tp_select_member"
  ON transaction_participants FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.id = transaction_id
        AND (is_trip_member(t.trip_id) OR is_trip_skipper(t.trip_id))
    )
  );

CREATE POLICY "tp_cud_member"
  ON transaction_participants FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.id = transaction_id
        AND (is_trip_member(t.trip_id) OR is_trip_skipper(t.trip_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.id = transaction_id
        AND (is_trip_member(t.trip_id) OR is_trip_skipper(t.trip_id))
    )
  );


-- ── Realtime aktivieren ────────────────────────────────────────────────
-- Damit die Crew live sieht, wenn jemand etwas einträgt.
ALTER PUBLICATION supabase_realtime ADD TABLE transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE transaction_participants;
ALTER PUBLICATION supabase_realtime ADD TABLE trip_members;
