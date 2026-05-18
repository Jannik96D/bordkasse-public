-- ═══════════════════════════════════════════════════════════════════════
-- 0020 — trip_statistics_audience: Sichtbarkeit der gepurgten Aggregate
--
-- Nach DSGVO-Purge werden trip_members gelöscht (siehe 0011/0018). Damit
-- verliert ein regulärer User per RLS den Lesezugriff auf trip_statistics
-- für seinen früheren Törn — die Daten sind zwar da (Admin sieht sie), aber
-- für die Crew unsichtbar. Damit ist die Cross-Trip-/Gesamt-Statistik unter
-- /stats für reguläre User nach 30 Tagen lückig.
--
-- Lösung: vor dem Löschen von trip_members eine winzige Spur in
-- trip_statistics_audience persistieren (Person-ID + Trip-ID, sonst nichts).
-- Die ergänzende RLS-Policy gewährt dem User Lesezugriff auf seine
-- gepurgten Aggregate über diese Audience-Tabelle.
--
-- Datenschutz-Implikation: das ist ein minimaler Personenbezug (Person X
-- war Mitglied von Trip Y), der bei Account-Löschung über ON DELETE CASCADE
-- mitgelöscht wird. Doku-Anpassung in /datenschutz erfolgt in derselben PR.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trip_statistics_audience (
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  trip_id   UUID NOT NULL REFERENCES trips(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_tsa_person ON trip_statistics_audience(person_id);
CREATE INDEX IF NOT EXISTS idx_tsa_trip   ON trip_statistics_audience(trip_id);

ALTER TABLE trip_statistics_audience ENABLE ROW LEVEL SECURITY;

-- User sieht seine eigene Audience-Row (für die JOIN-Validierung in den
-- erweiterten trip_statistics- und trips-Policies). Service-Role bypasst
-- RLS sowieso.
DROP POLICY IF EXISTS "tsa_select_self" ON trip_statistics_audience;
CREATE POLICY "tsa_select_self"
  ON trip_statistics_audience FOR SELECT TO authenticated
  USING (
    person_id IN (SELECT id FROM persons WHERE auth_user_id = auth.uid())
  );


-- ── trip_statistics-Policy erweitern: Audience-Pfad ──────────────────
-- Bisher (Migration 0011): is_trip_member OR is_trip_skipper. Beide
-- Predicate werden nach Purge falsch, weil trip_members leer ist.
DROP POLICY IF EXISTS "trip_statistics_select_member" ON trip_statistics;
CREATE POLICY "trip_statistics_select_member"
  ON trip_statistics FOR SELECT TO authenticated
  USING (
    is_trip_member(trip_id)
    OR is_trip_skipper(trip_id)
    OR EXISTS (
      SELECT 1 FROM trip_statistics_audience a
       WHERE a.trip_id   = trip_statistics.trip_id
         AND a.person_id IN (SELECT id FROM persons WHERE auth_user_id = auth.uid())
    )
  );


-- ── trips-Policy erweitern: Audience-Pfad ────────────────────────────
-- Damit der User für gepurgte Trips Name/Datum noch lesen kann.
-- (Die bestehende trips_select_member-Policy aus 0004 deckt nur Member +
-- Skipper ab.) Wir legen eine zusätzliche permissive Policy an statt der
-- alten anzufassen — Supabase OR-merged permissive Policies.
DROP POLICY IF EXISTS "trips_select_audience" ON trips;
CREATE POLICY "trips_select_audience"
  ON trips FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trip_statistics_audience a
       WHERE a.trip_id   = trips.id
         AND a.person_id IN (SELECT id FROM persons WHERE auth_user_id = auth.uid())
    )
  );


-- ── purge_trip_data: Audience persistieren vor dem trip_members-DELETE ─
-- Wir ersetzen die Function 1:1 (gleiche Signatur), inklusive bestehender
-- Settlement-/Schulden-Gates, und ergänzen den INSERT in audience direkt
-- vor `DELETE FROM trip_members`. Nur Personen mit auth_user_id (echte
-- Login-User) werden eingetragen — Ghost-Members werden in 0011/0018
-- sowieso als verwaiste Person-Row gelöscht.
CREATE OR REPLACE FUNCTION purge_trip_data(p_trip_id UUID, p_force BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_trip RECORD;
BEGIN
  SELECT id, end_date, settlement_announced_at, retention_purged_at
    INTO v_trip
    FROM trips
   WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_trip.retention_purged_at IS NOT NULL THEN
    RETURN 'already_purged';
  END IF;

  IF NOT p_force THEN
    IF v_trip.end_date >= (now() - interval '30 days')::date THEN
      RETURN 'too_young';
    END IF;
    IF v_trip.settlement_announced_at IS NULL THEN
      RETURN 'no_settlement';
    END IF;
  END IF;

  IF NOT all_debts_settled(p_trip_id) THEN
    RETURN 'debts_open';
  END IF;

  -- Aggregate sichern (idempotent)
  INSERT INTO trip_statistics (trip_id, date, category_name, total_amount, alcohol_amount, count)
  SELECT
    t.trip_id,
    t.date,
    COALESCE(c.name, 'Ohne Kategorie') AS category_name,
    SUM(t.amount) AS total_amount,
    SUM(t.alcohol_amount) AS alcohol_amount,
    COUNT(*) AS count
  FROM transactions t
  LEFT JOIN trip_categories c ON c.id = t.category_id
  WHERE t.trip_id = p_trip_id
    AND t.type = 'expense'
    AND t.deleted_at IS NULL
  GROUP BY t.trip_id, t.date, c.name
  ON CONFLICT (trip_id, date, category_name) DO NOTHING;

  -- NEU: Audience-Spur — Member mit echtem Login-Account merken, damit sie
  -- ihre Cross-Trip-Statistik auch nach Purge weiter sehen können.
  INSERT INTO trip_statistics_audience (person_id, trip_id)
  SELECT tm.person_id, tm.trip_id
    FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
   WHERE tm.trip_id = p_trip_id
     AND p.auth_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Personenbezogene Tabellen leeren (unverändert ggü. 0018)
  DELETE FROM transaction_participants
    WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = p_trip_id);
  DELETE FROM settled_debts WHERE trip_id = p_trip_id;
  DELETE FROM trip_members WHERE trip_id = p_trip_id;
  DELETE FROM transactions WHERE trip_id = p_trip_id;
  DELETE FROM audit_log WHERE trip_id = p_trip_id;
  DELETE FROM trip_categories WHERE trip_id = p_trip_id;

  UPDATE trips
     SET skipper_id = NULL,
         retention_purged_at = now()
   WHERE id = p_trip_id;

  -- Verwaiste Ghost-Personen entfernen
  DELETE FROM persons p
   WHERE p.auth_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_members tm WHERE tm.person_id = p.id);

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION purge_trip_data(UUID, BOOLEAN) TO service_role;
