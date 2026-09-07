-- ═══════════════════════════════════════════════════════════════════════
-- 0051 — Self-Service-Kontolöschung tatsächlich funktionsfähig machen
-- (Sanierungsplan 2026-09, PR 2, Fund 2 + Fund 23 proportional)
--
-- Produktionsdefekt: `deleteMyAccount` (app/profile/actions.ts) ruft
-- `delete_my_account()` über den SERVICE-ROLE-Client auf
-- (`admin.rpc("delete_my_account")`). Die Function bestimmt die zu
-- löschende Person aber über `auth.uid()` — das liest den `sub`-Claim aus
-- dem JWT der aktuellen Anfrage. Bei einem Service-Role-Aufruf trägt
-- dieses JWT keinen (oder keinen zur echten Person passenden) `sub`-Claim,
-- `auth.uid()` liefert daher NULL, und `WHERE auth_user_id = auth.uid()`
-- ist wegen NULL-Vergleich (NULL = NULL ist NULL, nicht TRUE) in SQL NIE
-- erfüllt. Die Function gibt für JEDEN Aufruf `'not_authenticated'` zurück
-- und tut NICHTS — der „Konto löschen"-Button in /profile hat seit
-- Einführung nie funktioniert. Ein pgTAP-Test kann das nicht abbilden:
-- pgTAP läuft ohne PostgREST/JWT-Kontext als Superuser, dort liefert auch
-- die ALTE Function für JEDEN Aufruf `not_authenticated` — der Defekt
-- entsteht ausschließlich durch die Kombination "SECURITY DEFINER +
-- auth.uid() + Aufruf über Service-Role", die nur in echten
-- PostgREST-Requests sichtbar wird.
--
-- Fix: eine neue Function, die die zu löschende Person als PARAMETER
-- entgegennimmt statt sie aus dem JWT zu erraten — der Name macht das
-- explizit ("lösche die Daten DIESER Person", nicht "meine"). Ohne die
-- REVOKE/GRANT-Zeilen im SELBEN Migrationsschritt wäre das ein
-- "lösche eine BELIEBIGE Person"-Endpunkt (PostgreSQL vergibt EXECUTE bei
-- CREATE FUNCTION implizit an PUBLIC, siehe Fund 1/0049) — die
-- Autorisierung (nur die eigene Person darf sich selbst löschen) bleibt
-- App-Layer-Verantwortung in `deleteMyAccount`, das seinerseits über
-- `getCurrentPerson()` + Session-Cookie sicherstellt, WESSEN `person.id`
-- übergeben wird.
--
-- ⚠️ Anders als bei rein additiven Migrationen gibt es hier KEINEN
-- Übergangs-Fallback in der App: `deleteMyAccount` ruft ab diesem PR
-- AUSSCHLIESSLICH `admin_delete_person_data` auf. Läuft der App-Deploy vor
-- dieser Migration (der in CLAUDE.md dokumentierte Versionsversatz-Fall),
-- scheitert die RPC mit einem harten "function does not exist" — der
-- Löschen-Button zeigt dann nur die generische Fehlermeldung, kein
-- Datenverlust, aber verwirrend, bis die Migration nachgezogen ist. Diese
-- Migration MUSS deshalb vor dem App-Deploy stehen (siehe R5).
--
-- Additiv (in die andere Richtung, App vor DB): die alte 0-arg
-- `delete_my_account()` (aus 0021, zuletzt 0043) bleibt bestehen — sie tut
-- real nichts Schädliches (liefert nur `not_authenticated`), ein Drop ist
-- deshalb unkritisch, wird aber trotzdem NICHT in diesem PR entfernt, um
-- das manuelle Migrationsfenster niemals eine fehlende Funktion treffen zu
-- lassen. Drop im Folge-PR, sobald `app/profile/actions.ts` nachweislich
-- nur noch die neue Function
-- aufruft.
--
-- Proportionale Ergänzung (Fund 23): zusätzlich zur bestehenden
-- Anonymisierung der `persons`-Row wird `audit_log.actor_person_id` für
-- die gelöschte Person genullt — nicht die Audit-ZEILEN selbst (das
-- widerspräche dem Append-only-Prinzip und zerstörte die Spur für den
-- Skipper), nur die direkte Personen-Referenz. Die Spalte ist bereits
-- `ON DELETE SET NULL` (0006_audit_log.sql:18), diese Function löscht die
-- `persons`-Row aber nie (nur Anonymisierung per UPDATE) — das FK-Cascade
-- feuert deshalb nie von selbst, daher hier explizit.
--
-- Regressionstest: supabase/tests/admin_delete_person_data_test.sql
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION admin_delete_person_data(p_person_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_active_with_bookings INTEGER;
BEGIN
  IF p_person_id IS NULL OR NOT EXISTS (SELECT 1 FROM persons WHERE id = p_person_id) THEN
    RETURN 'not_authenticated';
  END IF;

  -- Blocker: Person hat Buchungen in einem AKTIVEN Trip
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

  -- 0. Web-Push-Abos löschen — die persons-Row wird unten nur anonymisiert
  --    (nicht gelöscht), daher greift ON DELETE CASCADE hier NICHT.
  DELETE FROM push_subscriptions WHERE person_id = p_person_id;

  -- 0b. Anzahlungs-Spuren löschen (gleiche CASCADE-feuert-nicht-Logik).
  DELETE FROM prepayment_reminder_log WHERE person_id = p_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = p_person_id;

  -- 1. Personenbezogene private Daten löschen.
  DELETE FROM persons_private WHERE person_id = p_person_id;

  -- 2. Sichtbarkeits-Marker für gepurgte Trips löschen.
  DELETE FROM trip_statistics_audience WHERE person_id = p_person_id;

  -- 3. Pre-Trip-Mitgliedschaften ohne Buchungs-Spur entfernen.
  DELETE FROM trip_members tm
   WHERE tm.person_id = p_person_id
     AND NOT EXISTS (
       SELECT 1 FROM transactions tx
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND (
            tx.paid_by     = p_person_id OR
            tx.credit_from = p_person_id OR
            tx.credit_to   = p_person_id
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM transaction_participants tp
         JOIN transactions tx ON tx.id = tp.transaction_id
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND tp.person_id = p_person_id
     );

  -- 4. Audit-Log-Referenz kappen (Fund 23, proportional — Zeilen bleiben,
  --    nur die direkte Personen-Referenz wird entfernt).
  UPDATE audit_log SET actor_person_id = NULL WHERE actor_person_id = p_person_id;

  -- 5. persons-Row anonymisieren.
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
