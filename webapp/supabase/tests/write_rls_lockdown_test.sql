-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0047 (Code-Review 2026-08, Fund 1) UND
-- 0050 (Sanierungsplan 2026-09, PR 1, Funde 3/4/44):
-- alle Schreib-Pfade laufen über den Service-Role-Client, nicht über den
-- Cookie-/Browser-Client. Diese Datei beweist, dass ein normales,
-- eingeloggtes Crewmitglied — OHNE App-Code, direkt per PostgREST-Data-API
-- (simuliert über `SET LOCAL ROLE authenticated` + `request.jwt.claims`) —
-- keine der folgenden Eskalationen mehr durchführen kann.
--
-- ⚠️ Seit 0050 tragen `authenticated`/`anon` GAR KEIN INSERT/UPDATE/DELETE-
-- GRANT mehr auf public-Tabellen. PostgreSQL prüft das Tabellen-Privileg
-- VOR jeder RLS-Policy-Auswertung — jedes INSERT/UPDATE/DELETE wirft
-- deshalb jetzt 42501 ("permission denied for table"), UNABHÄNGIG davon,
-- ob die WHERE-Klausel überhaupt eine Zeile träfe. Vor 0050 (nur die
-- RLS-Policies aus 0047 gedroppt, GRANT aber noch vorhanden) lieferte
-- ein UPDATE/DELETE ohne passende Policy dagegen 0 Zeilen. Alle Checks
-- unten sind daher `throws_ok(..., '42501', ...)`, nicht `is(count, 0)`.
--
-- Geprüfte Eskalationen:
--   1. Crew befördert sich selbst zum Co-Skipper (trip_members.is_skipper)
--   2. Crew verstellt eigene Anwesenheit
--   3. Crew legt eine Gutschrift direkt an (App: Skipper/Admin-only)
--   4. Crew löscht eine fremde Buchung physisch (App: nur Soft-Delete)
--   5. Crew fälscht deleted_at selbst (Soft-Delete ohne Audit-Log-Eintrag)
--   6. Skipper legt einen neuen Törn per direktem INSERT an
--   7. Skipper benennt seinen eigenen Törn per direktem UPDATE um
--   8. Skipper löscht seinen eigenen Törn per direktem DELETE
--   9. Skipper legt eine Anzahlungs-Tranche per direktem INSERT an
--  10. Crew ändert den eigenen Anzeigenamen per direktem UPDATE auf persons
--
-- Die Skipper-Fälle (6-9) sind bewusst dabei: vor 0050 hatte GENAU diese
-- Rolle explizite Schreib-Policies (trips_insert_self/-update_skipper/
-- -delete_skipper, tr_cud_skipper) — sie beweisen, dass der GRANT-Revoke
-- greift, nicht nur eine Policy-Lücke bei Nicht-Skippern.
--
-- Gegenprobe (Fund 1/44 dürfen NICHT zu Über-Härtung führen): der
-- Cookie-Client muss weiterhin lesen können — sonst bricht z. B. Realtime.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(14);

-- ── Setup: Skipper P1 + normales Mitglied P2, beide mit Login, ein Törn
-- mit einer Ausgabe, damit es etwas zu manipulieren/lesen gibt. ──────────
INSERT INTO auth.users(id) VALUES
  ('47470000-0000-4000-8000-0000000000f1'),
  ('47470000-0000-4000-8000-0000000000f2');

INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('47470000-0000-4000-8000-000000000001', 'RLS-Lock P1 (Skipper)', '47470000-0000-4000-8000-0000000000f1'),
  ('47470000-0000-4000-8000-000000000002', 'RLS-Lock P2 (Crew)',    '47470000-0000-4000-8000-0000000000f2');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('47470000-0000-4000-8000-0000000000aa', 'pgTAP Write-RLS-Lockdown',
   '2026-05-01', '2026-05-10', '47470000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id, is_skipper, on_board_from, on_board_to) VALUES
  ('47470000-0000-4000-8000-0000000000aa', '47470000-0000-4000-8000-000000000001', TRUE, NULL, NULL),
  ('47470000-0000-4000-8000-0000000000aa', '47470000-0000-4000-8000-000000000002', FALSE, NULL, NULL);

INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('47470000-0000-4000-8000-0000000000e1', '47470000-0000-4000-8000-0000000000aa',
   'expense', '2026-05-02', 'Lebensmittel', 60,
   '47470000-0000-4000-8000-000000000001', 'equal');

-- ── Als P2 (normales Crewmitglied, NICHT Skipper) impersonieren ───────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '47470000-0000-4000-8000-0000000000f2')::text, TRUE);

-- 1. Selbst-Beförderung zum Co-Skipper: kein Tabellen-GRANT mehr → 42501.
SELECT throws_ok(
  $$UPDATE trip_members SET is_skipper = TRUE
     WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
       AND person_id = '47470000-0000-4000-8000-000000000002'$$,
  '42501', NULL,
  'Crew kann sich nicht per direktem UPDATE selbst zum Co-Skipper machen');

-- 2. Eigene Anwesenheit manipulieren: ebenfalls 42501.
SELECT throws_ok(
  $$UPDATE trip_members SET on_board_from = '2099-01-01', on_board_to = '2099-01-02'
     WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
       AND person_id = '47470000-0000-4000-8000-000000000002'$$,
  '42501', NULL,
  'Crew kann eigene Anwesenheit nicht per direktem UPDATE manipulieren');

-- 3. Gutschrift direkt anlegen (App: Skipper/Admin-only): 42501.
SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to)
    VALUES ('47470000-0000-4000-8000-0000000000aa', 'credit', CURRENT_DATE, 500,
            '47470000-0000-4000-8000-000000000002', '47470000-0000-4000-8000-000000000001')$$,
  '42501', NULL,
  'Crew kann keine Gutschrift per direktem INSERT anlegen');

-- 4. Fremde Buchung physisch löschen: 42501.
SELECT throws_ok(
  $$DELETE FROM transactions WHERE id = '47470000-0000-4000-8000-0000000000e1'$$,
  '42501', NULL,
  'Crew kann eine Buchung nicht per direktem DELETE hart löschen');

-- 5. deleted_at selbst fälschen (Soft-Delete ohne Audit-Spur): 42501.
SELECT throws_ok(
  $$UPDATE transactions SET deleted_at = now()
     WHERE id = '47470000-0000-4000-8000-0000000000e1'$$,
  '42501', NULL,
  'Crew kann deleted_at nicht per direktem UPDATE selbst setzen');

RESET ROLE;

-- ── Als P1 (Skipper, hatte VOR 0050 explizite Schreib-Policies auf
-- trips/prepayment_tranches) impersonieren — beweist, dass der
-- GRANT-Revoke greift, nicht nur eine Policy-Lücke bei Nicht-Skippern. ──
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '47470000-0000-4000-8000-0000000000f1')::text, TRUE);

-- 6. Skipper kann keinen neuen Törn per direktem INSERT anlegen: 42501.
SELECT throws_ok(
  $$INSERT INTO trips(name, start_date, end_date, skipper_id)
    VALUES ('pgTAP Dead-Grant-Trip', '2026-06-01', '2026-06-10',
            '47470000-0000-4000-8000-000000000001')$$,
  '42501', NULL,
  'Skipper kann keinen Törn mehr per direktem INSERT anlegen (GRANT-Revoke)');

-- 7. Skipper kann seinen eigenen Törn nicht mehr per direktem UPDATE
-- umbenennen: 42501.
SELECT throws_ok(
  $$UPDATE trips SET name = 'Umbenannt-Sollte-Nicht-Klappen'
     WHERE id = '47470000-0000-4000-8000-0000000000aa'$$,
  '42501', NULL,
  'Skipper kann seinen Törn nicht mehr per direktem UPDATE umbenennen');

-- 8. Skipper kann seinen Törn nicht mehr per direktem DELETE löschen: 42501.
SELECT throws_ok(
  $$DELETE FROM trips WHERE id = '47470000-0000-4000-8000-0000000000aa'$$,
  '42501', NULL,
  'Skipper kann seinen Törn nicht mehr per direktem DELETE löschen');

-- 9. Skipper kann keine Anzahlungs-Tranche mehr per direktem INSERT
-- anlegen: 42501.
SELECT throws_ok(
  $$INSERT INTO prepayment_tranches(trip_id, due_date, label, percent)
    VALUES ('47470000-0000-4000-8000-0000000000aa', '2026-05-01',
            'Anzahlung', 50)$$,
  '42501', NULL,
  'Skipper kann keine Anzahlungs-Tranche mehr per direktem INSERT anlegen');

RESET ROLE;

-- ── Zurück zu P2: persons/persons_private ohne jedes Schreib-GRANT ─────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '47470000-0000-4000-8000-0000000000f2')::text, TRUE);

-- 10. Kein direktes UPDATE mehr auf persons (persons_update_self
-- gedroppt UND kein Tabellen-GRANT mehr): 42501.
SELECT throws_ok(
  $$UPDATE persons SET display_name = 'Manipuliert'
     WHERE id = '47470000-0000-4000-8000-000000000002'$$,
  '42501', NULL,
  'Crew kann display_name nicht mehr per direktem UPDATE auf persons ändern');

-- ── Gegenprobe: keine Über-Härtung — Lesen funktioniert weiterhin ─────
SELECT is(
  (SELECT is_skipper FROM trip_members
    WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
      AND person_id = '47470000-0000-4000-8000-000000000002'),
  FALSE, 'is_skipper ist unverändert FALSE geblieben');

SELECT is(
  (SELECT deleted_at FROM transactions WHERE id = '47470000-0000-4000-8000-0000000000e1'),
  NULL::timestamptz, 'deleted_at ist unverändert NULL geblieben');

SELECT is(
  (SELECT count(*) FROM transactions WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'),
  1::bigint, 'Crew liest die (unangetastete) Buchung weiterhin per RLS-SELECT');

SELECT is(
  (SELECT count(*) FROM trip_members WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'),
  2::bigint, 'Crew liest die Crew-Liste weiterhin per RLS-SELECT');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
