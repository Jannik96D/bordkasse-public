-- ═══════════════════════════════════════════════════════════════════════
-- 0008_co_skippers — Mehrere Skipper pro Trip
--
-- Bislang: trips.skipper_id verweist auf genau eine Person — der Original-
-- Anleger ist alleiniger Skipper.
-- Neu: trip_members.is_skipper kann pro Mitglied gesetzt werden, sodass
-- z. B. ein Co-Skipper auch Crew/Kategorien verwalten und Gutschriften
-- erstellen kann.
--
-- trips.skipper_id bleibt als "Original-Owner"-Marker erhalten (kann nicht
-- aus dem Trip entfernt oder seiner Skipper-Rolle entbunden werden); sein
-- entsprechender trip_members-Eintrag wird im Backfill auf is_skipper=TRUE
-- gesetzt. Der App-Code (lib/auth/authz.ts) prüft is_trip_skipper() über
-- die trip_members.is_skipper-Spalte.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trip_members
  ADD COLUMN IF NOT EXISTS is_skipper BOOLEAN NOT NULL DEFAULT FALSE;

-- Bestandsdaten: jeder Original-Skipper ist auch Skipper laut trip_members.
UPDATE trip_members tm
SET is_skipper = TRUE
FROM trips t
WHERE t.id = tm.trip_id
  AND t.skipper_id = tm.person_id
  AND tm.is_skipper IS DISTINCT FROM TRUE;

CREATE INDEX IF NOT EXISTS idx_trip_members_is_skipper
  ON trip_members(trip_id) WHERE is_skipper;

-- is_trip_skipper liest jetzt aus trip_members.is_skipper. SECURITY DEFINER
-- bleibt — die Function wird in RLS-Policies und v_balances/Skipper-Checks
-- aus App-Code aufgerufen.
CREATE OR REPLACE FUNCTION is_trip_skipper(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
    WHERE tm.trip_id = p_trip_id
      AND tm.is_skipper
      AND p.auth_user_id = auth.uid()
  );
$$;
