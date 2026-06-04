-- ═══════════════════════════════════════════════════════════════════════
-- 0038 — Web-Push-Abos (Geräte-Benachrichtigungen)
--
-- Speichert die Push-Subscriptions pro Person/Gerät. Eine Person kann
-- mehrere Geräte haben → mehrere Zeilen, eindeutig über den `endpoint`.
--
-- Schreib-/Lese-Pfad ausschließlich über Server-Actions/Dispatch mit dem
-- Service-Role-Key (wie `prepayment_reminder_log`). RLS ist an, OHNE Policy:
-- ein versehentlicher Zugriff mit User-JWT sieht/schreibt nichts. Der Client
-- kennt seinen eigenen Abo-Status lokal über
-- `registration.pushManager.getSubscription()` — er muss die Tabelle nie
-- direkt lesen.
--
-- DSGVO (wichtig): `delete_my_account()` löscht die Abos EXPLIZIT mit. Die
-- `persons`-Row wird beim Self-Delete nur anonymisiert (nicht gelöscht),
-- daher feuert das `ON DELETE CASCADE` dort NICHT — der DELETE muss in der
-- Funktion stehen, sonst bliebe der (personenbezogene) Endpoint liegen.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_person ON push_subscriptions (person_id);

COMMENT ON TABLE push_subscriptions IS
  'Web-Push-Abos pro Person/Gerät (eindeutig über endpoint). Nur Service-Role liest/schreibt; RLS an ohne Policy.';

-- RLS an, keine Policy → nur Service-Role kommt dran (wie prepayment_reminder_log).
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────────────────────────────────────────────────
-- delete_my_account() neu definieren: identisch zu 0021, PLUS DELETE der
-- Push-Abos. Der `search_path`-Pin aus 0033 wird hier INLINE mitgegeben —
-- CREATE OR REPLACE würde eine nur per ALTER gesetzte Einstellung sonst auf
-- den Default zurücksetzen und die Härtung aus 0033 stillschweigend rückgängig
-- machen.
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_person_id UUID;
  v_active_with_bookings INTEGER;
BEGIN
  SELECT id INTO v_person_id
    FROM persons
   WHERE auth_user_id = auth.uid();

  IF v_person_id IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  -- Blocker: User hat Buchungen in einem AKTIVEN Trip
  -- (end_date >= today AND retention_purged_at IS NULL).
  SELECT COUNT(*) INTO v_active_with_bookings
    FROM trips t
   WHERE t.retention_purged_at IS NULL
     AND t.end_date >= CURRENT_DATE
     AND (
       EXISTS (
         SELECT 1 FROM transactions tx
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND (
              tx.paid_by      = v_person_id OR
              tx.credit_from  = v_person_id OR
              tx.credit_to    = v_person_id
            )
       )
       OR EXISTS (
         SELECT 1 FROM transaction_participants tp
           JOIN transactions tx ON tx.id = tp.transaction_id
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND tp.person_id = v_person_id
       )
     );

  IF v_active_with_bookings > 0 THEN
    RETURN 'has_active_bookings';
  END IF;

  -- 0. Web-Push-Abos löschen — die persons-Row wird unten nur anonymisiert
  --    (nicht gelöscht), daher greift ON DELETE CASCADE hier NICHT.
  DELETE FROM push_subscriptions WHERE person_id = v_person_id;

  -- 1. Personenbezogene private Daten löschen.
  DELETE FROM persons_private WHERE person_id = v_person_id;

  -- 2. Sichtbarkeits-Marker für gepurgte Trips löschen.
  DELETE FROM trip_statistics_audience WHERE person_id = v_person_id;

  -- 3. Pre-Trip-Mitgliedschaften ohne Buchungs-Spur entfernen.
  DELETE FROM trip_members tm
   WHERE tm.person_id = v_person_id
     AND NOT EXISTS (
       SELECT 1 FROM transactions tx
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND (
            tx.paid_by     = v_person_id OR
            tx.credit_from = v_person_id OR
            tx.credit_to   = v_person_id
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM transaction_participants tp
         JOIN transactions tx ON tx.id = tp.transaction_id
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND tp.person_id = v_person_id
     );

  -- 4. persons-Row anonymisieren.
  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = v_person_id;

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;
