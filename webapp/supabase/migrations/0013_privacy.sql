-- ═══════════════════════════════════════════════════════════════════════
-- 0013_privacy — Privacy-Split persons / persons_private
--
-- Bisher: persons enthält display_name UND email; persons-RLS ist
--         USING (TRUE) — jede authentifizierte Person sieht alle E-Mails.
--         Das ist nicht datenschutzkonform.
--
-- Neu:    persons.display_name bleibt PUBLIC (Vorname + optional Initial),
--         persons_private (last_name, email) — sichtbar nur Self oder
--         Trip-Skipper, in dessen Trip die Person Mitglied ist.
--
-- App-Architektur: Server Actions schreiben mit Service-Role-Admin-Client
-- (RLS bypassed), Reads aus Server Components nutzen Cookie-Client mit
-- User-JWT (RLS aktiv). Daher gibt es keine INSERT-Policy auf
-- persons_private — Schreibpfad ist ausschließlich der Admin-Client.
--
-- Hinweis zum Co-Skipper-Modell: `is_trip_skipper(trip_id)` aus
-- 0008_co_skippers.sql wird hier wiederverwendet, um „Trip-Admin" zu
-- definieren (Original-Skipper UND Co-Skipper haben Read-Zugriff auf
-- persons_private der eigenen Crew).
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS citext;

-- ── 1. persons_private: sensible Daten ─────────────────────────────────
CREATE TABLE persons_private (
  person_id  UUID PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  last_name  TEXT,
  email      CITEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_persons_private_email ON persons_private(email);

-- ── 2. Daten-Migration: persons.email → persons_private.email ──────────
INSERT INTO persons_private (person_id, email)
SELECT id, email
FROM   persons
WHERE  email IS NOT NULL
ON CONFLICT (person_id) DO NOTHING;

-- ── 3. persons.email droppen ───────────────────────────────────────────
DROP INDEX IF EXISTS idx_persons_email_lower;
ALTER TABLE persons DROP COLUMN email;

COMMENT ON COLUMN persons.display_name IS
  'Öffentlich sichtbarer Name — ausschließlich Vorname (+ optional Initial bei '
  'Namensgleichheit, z.B. "Lukas K."). NIEMALS Nachnamen hier ablegen — die '
  'gehören in persons_private.last_name.';

-- ── 4. RLS auf persons: USING (TRUE) → Self OR Crew-Kollege ────────────
DROP POLICY IF EXISTS persons_select_authenticated ON persons;

CREATE POLICY "persons_visible_to_crew_or_self"
  ON persons FOR SELECT
  TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM trip_members WHERE person_id = persons.id
    )
  );
-- trip_members hat eigene RLS, die nur Rows der mir zugänglichen Trips
-- liefert — EXISTS findet also nur Personen mit gemeinsamem Trip.

-- ── 5. RLS auf persons_private (neu) ───────────────────────────────────
ALTER TABLE persons_private ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pp_select_self_or_skipper"
  ON persons_private FOR SELECT
  TO authenticated
  USING (
    -- Self
    EXISTS (
      SELECT 1 FROM persons p
      WHERE p.id = persons_private.person_id
        AND p.auth_user_id = auth.uid()
    )
    -- Trip-Skipper eines Trips, in dem die Person Mitglied ist
    OR EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.person_id = persons_private.person_id
        AND is_trip_skipper(tm.trip_id)
    )
  );

CREATE POLICY "pp_update_self"
  ON persons_private FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM persons p
      WHERE p.id = persons_private.person_id
        AND p.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM persons p
      WHERE p.id = persons_private.person_id
        AND p.auth_user_id = auth.uid()
    )
  );

-- INSERT/DELETE: keine Policy — beide Pfade laufen ausschließlich über
-- den Service-Role-Admin-Client (siehe lib/supabase/admin.ts).

-- ── 6. Realtime: persons_private NICHT in publication ──────────────────
-- Bordkasse publisht nur explizit ausgewählte Tabellen für Realtime.
-- persons_private wird bewusst nicht hinzugefügt, damit E-Mails/Namen
-- nicht über Realtime-Channels propagieren.
