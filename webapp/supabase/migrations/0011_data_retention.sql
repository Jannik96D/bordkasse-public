-- ═══════════════════════════════════════════════════════════════════════
-- 0011_data_retention — DSGVO-Löschung 30 Tage nach Törn-Ende
--
-- Personenbezogene Daten (trip_members, settled_debts, transactions mit
-- Person-Referenzen, audit_log, Ghost-persons) werden 30 Tage nach dem
-- Törn-Ende automatisch gelöscht. Aggregierte Statistik-Daten (Datum,
-- Kategorie, Summe) bleiben in trip_statistics erhalten — komplett
-- anonymisiert, kein Bezug zu konkreten Personen.
--
-- Aufgerufen wird die Function purge_expired_trip_data() über einen
-- täglichen Cron-Job (Vercel Cron → /api/cron/purge → RPC).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Aggregat-Tabelle für Statistik nach Purge ──────────────────────
CREATE TABLE trip_statistics (
  trip_id          UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  category_name    TEXT NOT NULL DEFAULT 'Ohne Kategorie',
  total_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  alcohol_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, date, category_name)
);

ALTER TABLE trip_statistics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trip_statistics_select_member"
  ON trip_statistics FOR SELECT
  TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));


-- ── 2. trips.skipper_id darf nach Purge NULL sein ──────────────────────
ALTER TABLE trips ALTER COLUMN skipper_id DROP NOT NULL;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS retention_purged_at TIMESTAMPTZ;


-- ── 3. Purge-Function ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purge_expired_trip_data()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trip_rec RECORD;
  purged_count INTEGER := 0;
BEGIN
  FOR trip_rec IN
    SELECT id FROM trips
    WHERE retention_purged_at IS NULL
      AND end_date < (now() - interval '30 days')::date
  LOOP
    -- Aggregate vor der Löschung schreiben
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
    WHERE t.trip_id = trip_rec.id
      AND t.type = 'expense'
      AND t.deleted_at IS NULL
    GROUP BY t.trip_id, t.date, c.name
    ON CONFLICT (trip_id, date, category_name) DO NOTHING;

    -- Personenbezogene Tabellen leeren
    DELETE FROM transaction_participants
      WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = trip_rec.id);
    DELETE FROM settled_debts WHERE trip_id = trip_rec.id;
    DELETE FROM trip_members WHERE trip_id = trip_rec.id;
    DELETE FROM transactions WHERE trip_id = trip_rec.id;
    DELETE FROM audit_log WHERE trip_id = trip_rec.id;
    DELETE FROM trip_categories WHERE trip_id = trip_rec.id;

    -- Trip behalten (Name + Datum für Statistik), Skipper-Verknüpfung kappen
    UPDATE trips
       SET skipper_id = NULL,
           retention_purged_at = now()
     WHERE id = trip_rec.id;

    purged_count := purged_count + 1;
  END LOOP;

  -- Verwaiste Ghost-Personen entfernen (kein Auth-User, keine aktive
  -- Trip-Mitgliedschaft mehr) — sie sind nirgends mehr referenced.
  DELETE FROM persons p
   WHERE p.auth_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_members tm WHERE tm.person_id = p.id);

  RETURN purged_count;
END;
$$;

-- Service-Role darf die Function aufrufen — der Vercel-Cron-Endpoint
-- nutzt den Admin-Client.
GRANT EXECUTE ON FUNCTION purge_expired_trip_data() TO service_role;
