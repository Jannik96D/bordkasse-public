-- ═══════════════════════════════════════════════════════════════════════
-- 0021 — Self-Service-Kontolöschung (DSGVO Art. 17 „Recht auf Löschung")
--
-- Bisher musste man eine Mail schicken, um sein Konto löschen zu lassen.
-- Diese Migration ergänzt eine Function `delete_my_account()`, die von der
-- Server-Action `deleteMyAccount` in `app/profile/actions.ts` aufgerufen wird.
--
-- Logik:
--   - Hard-Delete würde fremde Daten beschädigen (Audit-Log, fremde Trip-Crews,
--     paid_by-Referenzen in nicht-gepurgten Buchungen). Wir anonymisieren
--     stattdessen die `persons`-Row und löschen alle wirklich persönlichen
--     Spuren (persons_private, audience, Pre-Trip-Mitgliedschaften).
--   - Blocker: Wenn der User in einem **aktiven Trip** (end_date >= today,
--     retention_purged_at IS NULL) Buchungen erstellt hat (paid_by /
--     credit_from / credit_to / als Beteiligter in transaction_participants),
--     wird die Löschung abgewiesen. Erst nach Trip-Ende (oder wenn keine
--     Buchungen vorhanden sind) kann die Person sich selbst löschen.
--   - Pre-Trip-Mitgliedschaften (in trip_members eingetragen, aber noch keine
--     Buchungen) werden mit-entfernt — die Person ist nicht mehr Crew.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
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

  -- 1. Personenbezogene private Daten löschen.
  DELETE FROM persons_private WHERE person_id = v_person_id;

  -- 2. Sichtbarkeits-Marker für gepurgte Trips löschen (DSGVO-konsequent —
  --    nach Self-Delete sieht der User die alten anonymisierten Aggregate
  --    nicht mehr; sie bleiben aber für andere Ex-Member und Admin erhalten).
  DELETE FROM trip_statistics_audience WHERE person_id = v_person_id;

  -- 3. Pre-Trip-Mitgliedschaften ohne Buchungs-Spur entfernen. In Trips, wo
  --    die Person Buchungen erstellt hat, bleibt der trip_members-Eintrag —
  --    sonst würde die Bilanz inkonsistent. Der display_name auf der
  --    anonymisierten persons-Row macht klar, dass die Person weg ist.
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

  -- 4. persons-Row anonymisieren: Name wird neutral, auth-Verknüpfung kappen.
  --    Audit-Log + fremde paid_by-Verweise bleiben funktionsfähig, zeigen aber
  --    auf „Ehemaliges Crew-Mitglied".
  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = v_person_id;

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;
