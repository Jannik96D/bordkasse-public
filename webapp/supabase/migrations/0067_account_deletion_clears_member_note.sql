-- ═══════════════════════════════════════════════════════════════════════
-- 0067 — Kontolöschung nullt die Crew-Notiz (Regressions-Grill 2026-11)
--
-- Befund: Seit 0063 bleibt die Mitgliedschaft einer gelöschten Person in
-- beendeten Törns mit Buchungen bestehen (sonst wanderten ihre Anteile auf
-- die Crew). `trip_members.note` ist aber Freitext des Skippers zur Person
-- („Allergie …", „kommt mit dem Zug", Telefonnummer) — er blieb damit an der
-- anonymisierten Person hängen und war für die Crew weiter sichtbar.
--
-- Fix: `admin_delete_person_data` setzt in allen verbleibenden
-- Mitgliedschaften der Person `note = NULL`. Sonst ist die Function 1:1 die
-- Fassung aus 0063 (gleiche Prüfungen, gleiche Reihenfolge, gleiche
-- Rückgabecodes). `CREATE OR REPLACE` behält die ACL; REVOKE/GRANT werden
-- trotzdem explizit erneut gesetzt (Konvention aus 0066: Funktionen immer
-- explizit an die aufrufenden Rollen freigeben, nur service_role).
--
-- ⚠️ Deploy: Migration VOR dem App-Merge auf Prod einspielen (keine
-- App-Abhängigkeit, aber Konvention dieser Runde). Bestandsdaten bereits
-- gelöschter Personen werden NICHT nachträglich bereinigt (lesende Prüfung:
-- `select count(*) from trip_members tm join persons p on p.id = tm.person_id
--   where p.display_name = 'Ehemaliges Crew-Mitglied' and tm.note is not null`).
--
-- Regressionstest: supabase/tests/account_deletion_keeps_shares_test.sql
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION admin_delete_person_data(p_person_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_active_with_bookings INTEGER;
  v_person_is_alcoholic  BOOLEAN;
BEGIN
  IF p_person_id IS NULL OR NOT EXISTS (SELECT 1 FROM persons WHERE id = p_person_id) THEN
    RETURN 'not_authenticated';
  END IF;

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
              tx.paid_by      = p_person_id OR
              tx.credit_from  = p_person_id OR
              tx.credit_to    = p_person_id
            )
       )
       OR EXISTS (
         SELECT 1 FROM transaction_participants tp
           JOIN transactions tx ON tx.id = tp.transaction_id
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND tp.person_id = p_person_id
       )
     );

  IF v_active_with_bookings > 0 THEN
    RETURN 'has_active_bookings';
  END IF;

  -- 0058: Posten-Empfänger in einem laufenden Törn.
  IF EXISTS (
    SELECT 1 FROM prepayment_items pi
      JOIN trips t ON t.id = pi.trip_id
     WHERE pi.payee_person_id = p_person_id
       AND t.retention_purged_at IS NULL
       AND t.end_date >= CURRENT_DATE
  ) THEN
    RETURN 'is_active_item_payee';
  END IF;

  -- 0063: Mitglied eines laufenden oder künftigen Törns — auch ganz ohne
  -- eigene Buchung (Mitesser). Siehe Kopfkommentar (b).
  IF EXISTS (
    SELECT 1 FROM trip_members tm
      JOIN trips t ON t.id = tm.trip_id
     WHERE tm.person_id = p_person_id
       AND t.retention_purged_at IS NULL
       AND t.end_date >= CURRENT_DATE
  ) THEN
    RETURN 'is_active_member';
  END IF;

  -- Ab hier wird geschrieben. Bisherigen Personenwert VOR jeder Änderung
  -- merken (für (c)).
  SELECT is_alcoholic INTO v_person_is_alcoholic FROM persons WHERE id = p_person_id;

  DELETE FROM push_subscriptions WHERE person_id = p_person_id;

  DELETE FROM prepayment_reminder_log WHERE person_id = p_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = p_person_id;
  DELETE FROM prepayment_item_obligations WHERE person_id = p_person_id;
  DELETE FROM prepayment_item_reminder_log WHERE person_id = p_person_id;

  DELETE FROM persons_private WHERE person_id = p_person_id;

  DELETE FROM trip_statistics_audience WHERE person_id = p_person_id;

  -- 0063: Mitgliedschaft nur noch in Törns OHNE jede (nicht gelöschte)
  -- Buchung entfernen — unabhängig davon, ob die Person selbst daran
  -- beteiligt war. Sobald es eine Buchung gibt, kann die Mitgliedschaft
  -- über v_transaction_shares (equal/on_board/time_proportional/„An Alle")
  -- Geld tragen, auch ohne eigene Buchungsspur.
  DELETE FROM trip_members tm
   WHERE tm.person_id = p_person_id
     AND NOT EXISTS (
       SELECT 1 FROM transactions tx
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
     )
     -- 0058: Posten-Empfänger bleibt Crew dieses Törns, auch nach Törnende:
     -- späte Rückzahlungen der Crew (credit_to = Empfänger) wirken sonst
     -- nicht mehr in der mitgliedschaftsgetriebenen v_balances → Σ ≠ 0.
     AND NOT EXISTS (
       SELECT 1 FROM prepayment_items pi
        WHERE pi.trip_id = tm.trip_id
          AND pi.payee_person_id = p_person_id
     );

  -- 0063 (c): Trinker-Flag in den verbleibenden Mitgliedschaften festhalten,
  -- bevor das Personen-Flag zurückgesetzt wird.
  UPDATE trip_members
     SET is_alcoholic = COALESCE(v_person_is_alcoholic, FALSE)
   WHERE person_id = p_person_id
     AND is_alcoholic IS NULL;

  -- 0067: Freitext-Notiz des Skippers zur Person in den verbleibenden
  -- Mitgliedschaften entfernen (kann Personendaten tragen).
  UPDATE trip_members
     SET note = NULL
   WHERE person_id = p_person_id
     AND note IS NOT NULL;

  UPDATE audit_log SET actor_person_id = NULL WHERE actor_person_id = p_person_id;

  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = p_person_id;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION admin_delete_person_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_person_data(UUID) TO service_role;
