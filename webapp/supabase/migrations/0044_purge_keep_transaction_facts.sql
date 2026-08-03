-- ═══════════════════════════════════════════════════════════════════════
-- 0044 — Purge: Buchungs-Kerndaten erhalten, nur Personenbezug entfernen
--
-- Bisher löschte purge_trip_data die komplette transactions-Zeile
-- (DELETE FROM transactions WHERE trip_id = ...). Damit ging jeglicher
-- Erfahrungswert verloren — Betrag, Titel/Beschreibung und Alkohol-Anteil
-- pro Buchung wären für den Vergleich mit künftigen Törns nützlich, sind
-- aber nicht personenbezogen.
--
-- Neues Verhalten: transactions bleiben als Zeile erhalten, nur die
-- personenbeziehbaren Spalten (paid_by, credit_from, credit_to, created_by)
-- werden genullt — exakt wie bereits bei trips.skipper_id/
-- settlement_announced_by gehandhabt. transaction_participants (das
-- "wer war beteiligt / wie aufgeteilt") wird weiterhin komplett gelöscht.
-- trip_categories werden NICHT mehr gelöscht (keine Personendaten, nur
-- Name+Icon) — sonst würde transactions.category_id per ON DELETE SET NULL
-- verwaisen und die Kategorie-Zuordnung der Buchung ginge verloren.
--
-- Damit die Crew die erhaltenen Buchungen nach dem Purge (wenn
-- trip_members gelöscht ist) überhaupt noch lesen kann, bekommen
-- transactions + trip_categories dieselbe Audience-basierte SELECT-Policy
-- wie trips/trip_statistics aus 0020 (rein additiv, ODER-verknüpft mit den
-- bestehenden Member-Policies aus 0004).
-- ═══════════════════════════════════════════════════════════════════════

-- ── Audience-Policies für transactions + trip_categories ──────────────
DROP POLICY IF EXISTS "tx_select_audience" ON transactions;
CREATE POLICY "tx_select_audience"
  ON transactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trip_statistics_audience a
       WHERE a.trip_id   = transactions.trip_id
         AND a.person_id IN (SELECT id FROM persons WHERE auth_user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "tc_select_audience" ON trip_categories;
CREATE POLICY "tc_select_audience"
  ON trip_categories FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trip_statistics_audience a
       WHERE a.trip_id   = trip_categories.trip_id
         AND a.person_id IN (SELECT id FROM persons WHERE auth_user_id = auth.uid())
    )
  );

-- ── purge_trip_data: transactions anonymisieren statt löschen ────────
CREATE OR REPLACE FUNCTION purge_trip_data(p_trip_id UUID, p_force BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

  -- Aggregate sichern (idempotent) — bleibt zusätzlich zu den jetzt
  -- erhaltenen Einzelbuchungen bestehen (dient /stats-Gesamtstatistik).
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

  -- Audience-Spur — Member mit echtem Login-Account merken.
  INSERT INTO trip_statistics_audience (person_id, trip_id)
  SELECT tm.person_id, tm.trip_id
    FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
   WHERE tm.trip_id = p_trip_id
     AND p.auth_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Personenbezogene Tabellen leeren.
  DELETE FROM transaction_participants
    WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = p_trip_id);
  DELETE FROM settled_debts WHERE trip_id = p_trip_id;

  DELETE FROM prepayment_reminder_log WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_obligations WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_tranches WHERE trip_id = p_trip_id;
  DELETE FROM cabin_types WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_plan WHERE trip_id = p_trip_id;

  DELETE FROM trip_members WHERE trip_id = p_trip_id;

  -- ← Fix (dieser PR): Buchungszeilen bleiben erhalten (Betrag, Beschreibung,
  --   Alkohol-/Trinkgeld-Anteil, Datum, Kategorie, Aufteilungsart, Fremd-
  --   währungsfelder) — nur der Personenbezug wird entfernt. Vorher: DELETE
  --   FROM transactions WHERE trip_id = p_trip_id.
  UPDATE transactions
     SET paid_by = NULL,
         credit_from = NULL,
         credit_to = NULL,
         created_by = NULL
   WHERE trip_id = p_trip_id;

  DELETE FROM audit_log WHERE trip_id = p_trip_id;
  -- trip_categories bleiben erhalten (keine Personendaten, sonst würde
  -- transactions.category_id verwaisen).

  UPDATE trips
     SET skipper_id = NULL,
         settlement_announced_by = NULL,
         retention_purged_at = now()
   WHERE id = p_trip_id;

  -- Verwaiste Personen (Ghosts UND anonymisierte Ex-Accounts) nur löschen,
  -- wenn sie NIRGENDS mehr referenziert sind. Da transactions.paid_by/
  -- credit_from/credit_to/created_by für DIESEN Trip jetzt bereits genullt
  -- sind, prüft dieser Block weiterhin korrekt über alle (noch nicht
  -- gepurgten) Trips hinweg.
  DELETE FROM persons p
   WHERE p.auth_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_members tm WHERE tm.person_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM trips t
                      WHERE t.skipper_id = p.id OR t.settlement_announced_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transactions tx
                      WHERE tx.paid_by = p.id OR tx.credit_from = p.id
                         OR tx.credit_to = p.id OR tx.created_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transaction_participants tp WHERE tp.person_id = p.id);

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION purge_trip_data(UUID, BOOLEAN) TO service_role;
