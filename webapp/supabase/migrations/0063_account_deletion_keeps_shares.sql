-- ═══════════════════════════════════════════════════════════════════════
-- 0063 — Kontolöschung darf keine Anteile verschieben
--        (Sicherheitsrunde 2026-11, Slice 5)
--
-- Drei Befunde:
--
-- (a) `delete_my_account()` (0021, zuletzt 0061) war per
--     `GRANT … TO authenticated` direkt über
--     `POST /rest/v1/rpc/delete_my_account` aufrufbar — ein Seiteneingang,
--     der Personendaten anonymisiert, ohne das `auth.users`-Konto zu löschen
--     und ohne App-Logging. Die App ruft seit 0051 ausschließlich
--     `admin_delete_person_data` (Service-Role) auf; die alte Function hat
--     keinen Aufrufer mehr → DROP. Damit muss auch keine Änderung mehr
--     gespiegelt werden.
--
-- (b) `admin_delete_person_data` löschte `trip_members` einer Person, wenn
--     sie keine eigene Buchungsspur (paid_by / credit_* /
--     transaction_participants) hatte. `v_transaction_shares` leitet die
--     Anteile bei „Gleichmäßig", „An Bord", „Zeitanteilig" und „An
--     Alle"-Gutschriften aber AUSSCHLIESSLICH aus `trip_members` ab. Ein
--     reiner Mitesser (hat nur mitgegessen, nie bezahlt) verschwand damit
--     aus `v_balances`, und sein Anteil wanderte rückwirkend auf die übrige
--     Crew — auch nach verschickter Abrechnung. Neu:
--       • Mitglied eines laufenden oder künftigen Törns (end_date >= heute,
--         nicht gepurged) → `is_active_member`, NICHTS wird gelöscht. Ein
--         anonymisiertes Mitglied, das Crew bleibt, würde sonst an allen
--         künftigen „Gleichmäßig"-Ausgaben beteiligt; ein entferntes würde
--         die bisherigen umverteilen. Austragen muss der Skipper
--         (Entfernen bzw. Crewwechsel).
--       • Beendeter Törn mit IRGENDEINER nicht gelöschten Buchung →
--         Mitgliedschaft bleibt, die Person wird nur anonymisiert.
--       • Törn ohne Buchungen → Mitgliedschaft wird wie bisher entfernt.
--
-- (c) Die Function setzte `persons.is_alcoholic = FALSE`. Über
--     `COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE)` in
--     `v_transaction_shares` verschob das den Alkoholanteil in jedem Törn,
--     in dem `trip_members.is_alcoholic` NULL ist — auch bei Personen MIT
--     Buchungen, deren Mitgliedschaft bleibt. Neu: vor dem Zurücksetzen wird
--     der bisherige Personenwert in alle verbleibenden Mitgliedschaften mit
--     NULL-Flag übernommen. Das Personen-Flag selbst wird weiterhin
--     zurückgesetzt (kein Merkmal an der anonymisierten Person, das für
--     künftige Törns gälte).
--
-- Rückgabecodes: `ok`, `not_authenticated`, `has_active_bookings`,
-- `is_active_item_payee` (alle unverändert) + NEU `is_active_member`.
-- Die spezifischeren Altcodes werden zuerst geprüft, damit deren genauere
-- Meldung in der App erhalten bleibt.
--
-- ⚠️ Deploy: Migration läuft VOR dem App-Deploy. Die alte App kennt
-- `is_active_member` nicht und zeigt dafür ihren generischen Fehlerzweig
-- („Unerwartete Antwort: … Bitte später erneut versuchen.") — gelöscht wird
-- in diesem Fall nichts, es geht also nichts verloren.
--
-- Reihenfolge-Lehre aus 0048: diese Function löscht keine Tranchen/Posten,
-- es gibt also keinen FK-`SET NULL`, der einen CHECK vor dem anonymisierenden
-- UPDATE kippen könnte. Alle Prüfungen laufen VOR dem ersten Write.
--
-- Unverändert aus 0061: alles Übrige (Push-Abos, Anzahlungs-/Posten-Soll
-- und -Logs, persons_private, trip_statistics_audience, audit_log-Nullung,
-- Blocker `is_active_item_payee`, Posten-Empfänger bleibt Crew).
--
-- Regressionstest: supabase/tests/account_deletion_keeps_shares_test.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── (a) Seiteneingang schließen ────────────────────────────────────────
DROP FUNCTION IF EXISTS delete_my_account();

-- ── (b)+(c) admin_delete_person_data ───────────────────────────────────
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
