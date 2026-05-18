-- ═══════════════════════════════════════════════════════════════════════
-- 0018 — Purge nur wenn alle Zahlungen erledigt sind + manuell anstoßbar
--
-- Bisher: purge_expired_trip_data() löscht personenbezogene Daten 30 Tage
-- nach end_date — egal ob die Crew die Schulden untereinander wirklich
-- beglichen hatte.
--
-- Neu:
--   1. Voraussetzungen, damit ein Trip gelöscht wird:
--      a) end_date + 30 Tage in der Vergangenheit (wie bisher)
--      b) settlement_announced_at IS NOT NULL (Skipper hat Abrechnung
--         überhaupt erst freigeschaltet)
--      c) keine offenen Schulden mehr (simplify_debts → settled_debts
--         decken alle ab)
--   2. Manuelle Variante purge_trip_data(p_trip_id, p_force) für den
--      "Jetzt löschen"-Button. Mit p_force=true können Skipper/Admin auch
--      bei sonst nicht-erfüllten Bedingungen löschen — aber NIEMALS bei
--      offenen Schulden (das wäre Datenverlust ohne Abschluss).
-- ═══════════════════════════════════════════════════════════════════════

-- ── Helper: alle simplified-debts eines Trips bezahlt? ────────────────
CREATE OR REPLACE FUNCTION all_debts_settled(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM simplify_debts(p_trip_id) d
    WHERE NOT EXISTS (
      SELECT 1 FROM settled_debts s
      WHERE s.trip_id = p_trip_id
        AND s.from_person_id = d.from_person_id
        AND s.to_person_id = d.to_person_id
        AND s.amount = d.amount
    )
  );
$$;


-- ── Manueller Purge eines einzelnen Trips ─────────────────────────────
-- p_force=false: respektiert Retention-Frist + Settlement-Status; nur
--                wenn alle Schulden bezahlt sind.
-- p_force=true:  Skipper/Admin-Override für die Retention-Frist und das
--                Settlement-Flag. Aber: bei offenen Schulden weiterhin
--                Refusal — sonst geht Zahlungs-Status für die Crew verloren.
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

  -- Force-Modus überspringt Retention-Frist + Settlement-Check, NICHT aber
  -- die Schulden-Prüfung.
  IF NOT p_force THEN
    IF v_trip.end_date >= (now() - interval '30 days')::date THEN
      RETURN 'retention_not_reached';
    END IF;
    IF v_trip.settlement_announced_at IS NULL THEN
      RETURN 'settlement_not_announced';
    END IF;
  END IF;

  IF NOT all_debts_settled(p_trip_id) THEN
    RETURN 'debts_open';
  END IF;

  -- Aggregate sichern
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

  -- Personenbezogene Tabellen leeren
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
GRANT EXECUTE ON FUNCTION all_debts_settled(UUID) TO service_role;


-- ── Cron-Variante: nutzt die Single-Trip-Function intern ──────────────
CREATE OR REPLACE FUNCTION purge_expired_trip_data()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trip_rec RECORD;
  purged_count INTEGER := 0;
  result TEXT;
BEGIN
  FOR trip_rec IN
    SELECT id FROM trips
    WHERE retention_purged_at IS NULL
      AND end_date < (now() - interval '30 days')::date
      AND settlement_announced_at IS NOT NULL
  LOOP
    result := purge_trip_data(trip_rec.id, FALSE);
    IF result = 'ok' THEN
      purged_count := purged_count + 1;
    END IF;
    -- Trips mit offenen Schulden landen einfach wieder im nächsten Cron-Lauf.
  END LOOP;
  RETURN purged_count;
END;
$$;

GRANT EXECUTE ON FUNCTION purge_expired_trip_data() TO service_role;
