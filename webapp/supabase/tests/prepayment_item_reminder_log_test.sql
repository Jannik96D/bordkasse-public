-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0061: Dedup-Log der Posten-Erinnerungen.
--
-- Geprüft:
--   1. Zugriff: RLS an, keine Policy, anon/authenticated ohne jedes Recht
--      (Katalog UND funktional als eingeloggtes Crewmitglied), service_role
--      darf.
--   2. Integrität: UNIQUE (item, person, type), CHECK auf den Typ,
--      Composite-FK (kein Log auf einen Posten eines fremden Törns).
--   3. CASCADE: ein gelöschter Posten nimmt seine Log-Zeilen mit.
--   4. DSGVO: purge_trip_data (force=FALSE, wie der Cron) räumt das Log des
--      Törns ab; admin_delete_person_data und delete_my_account räumen das
--      Log der Person ab und lassen fremde Zeilen stehen.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(20);

-- ── Setup ─────────────────────────────────────────────────────────────
INSERT INTO auth.users(id) VALUES
  ('61610000-0000-4000-8000-0000000000f1'),
  ('61610000-0000-4000-8000-0000000000f2');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('61610000-0000-4000-8000-000000000001', 'Rem Empfänger', NULL),
  ('61610000-0000-4000-8000-000000000002', 'Rem Crew A', '61610000-0000-4000-8000-0000000000f1'),
  ('61610000-0000-4000-8000-000000000003', 'Rem Crew B', '61610000-0000-4000-8000-0000000000f2');

-- Törn L: zukünftig (für Zugriff, Integrität, Konto-Löschung).
-- Törn P: abgelaufen + abgerechnet (für den Purge).
INSERT INTO trips(id, name, start_date, end_date, skipper_id, settlement_announced_at) VALUES
  ('61610000-0000-4000-8000-0000000000aa', 'pgTAP Rem laufend', '2099-04-01', '2099-04-10',
   '61610000-0000-4000-8000-000000000001', NULL),
  ('61610000-0000-4000-8000-0000000000bb', 'pgTAP Rem abgelaufen', '2020-04-01', '2020-04-10',
   '61610000-0000-4000-8000-000000000001', now());

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-000000000001'),
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-000000000002'),
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-000000000003'),
  ('61610000-0000-4000-8000-0000000000bb', '61610000-0000-4000-8000-000000000001'),
  ('61610000-0000-4000-8000-0000000000bb', '61610000-0000-4000-8000-000000000003');

INSERT INTO prepayment_items(id, trip_id, label, total_amount, due_date, payee_person_id, split_type) VALUES
  ('61610000-0000-4000-8000-0000000000d1', '61610000-0000-4000-8000-0000000000aa',
   'Flüge', 300, '2099-03-01', '61610000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('61610000-0000-4000-8000-0000000000d2', '61610000-0000-4000-8000-0000000000aa',
   'Bahn', 90, '2099-03-01', '61610000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('61610000-0000-4000-8000-0000000000d3', '61610000-0000-4000-8000-0000000000bb',
   'Flüge alt', 100, '2020-03-01', '61610000-0000-4000-8000-000000000001', 'gleichmaessig');

INSERT INTO prepayment_item_reminder_log(trip_id, item_id, person_id, reminder_type) VALUES
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1', '61610000-0000-4000-8000-000000000002', 'item_crew_3d'),
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1', '61610000-0000-4000-8000-000000000003', 'item_crew_3d'),
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1', '61610000-0000-4000-8000-000000000001', 'item_payee_3d'),
  ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d2', '61610000-0000-4000-8000-000000000002', 'item_crew_3d'),
  ('61610000-0000-4000-8000-0000000000bb', '61610000-0000-4000-8000-0000000000d3', '61610000-0000-4000-8000-000000000003', 'item_crew_3d'),
  ('61610000-0000-4000-8000-0000000000bb', '61610000-0000-4000-8000-0000000000d3', '61610000-0000-4000-8000-000000000001', 'item_payee_3d');

-- ── 1. Zugriff ────────────────────────────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.prepayment_item_reminder_log'::regclass),
  'RLS ist aktiviert');

SELECT is(
  (SELECT count(*) FROM pg_policies WHERE tablename = 'prepayment_item_reminder_log'),
  0::bigint, 'Keine Policy → für Nutzer-JWTs nichts sichtbar');

SELECT ok(
  NOT has_table_privilege('anon', 'public.prepayment_item_reminder_log', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.prepayment_item_reminder_log', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.prepayment_item_reminder_log', 'DELETE'),
  'anon hat kein SELECT/INSERT/DELETE');

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.prepayment_item_reminder_log', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.prepayment_item_reminder_log', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.prepayment_item_reminder_log', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.prepayment_item_reminder_log', 'DELETE'),
  'authenticated hat kein SELECT/INSERT/UPDATE/DELETE');

SELECT ok(
  has_table_privilege('service_role', 'public.prepayment_item_reminder_log', 'SELECT')
  AND has_table_privilege('service_role', 'public.prepayment_item_reminder_log', 'INSERT')
  AND has_table_privilege('service_role', 'public.prepayment_item_reminder_log', 'DELETE'),
  'service_role darf lesen/schreiben/löschen (Cron, Reject)');

-- Funktional: ein eingeloggtes Crewmitglied DESSELBEN Törns kommt nicht dran.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '61610000-0000-4000-8000-0000000000f1', 'role', 'authenticated')::text, TRUE);
SELECT throws_ok(
  $$ SELECT count(*) FROM prepayment_item_reminder_log $$,
  '42501', NULL, 'Crewmitglied kann das Log nicht lesen');
SELECT throws_ok(
  $$ DELETE FROM prepayment_item_reminder_log WHERE person_id = '61610000-0000-4000-8000-000000000002' $$,
  '42501', NULL, 'Crewmitglied kann seinen Log-Eintrag nicht löschen (sonst Mahnung erneut auslösbar)');
RESET ROLE;

-- ── 2. Integrität ─────────────────────────────────────────────────────
SELECT throws_ok(
  $$ INSERT INTO prepayment_item_reminder_log(trip_id, item_id, person_id, reminder_type) VALUES
     ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1',
      '61610000-0000-4000-8000-000000000002', 'item_crew_3d') $$,
  '23505', NULL, 'UNIQUE (item, person, type): zweite Erinnerung derselben Art scheitert');

SELECT lives_ok(
  $$ INSERT INTO prepayment_item_reminder_log(trip_id, item_id, person_id, reminder_type) VALUES
     ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1',
      '61610000-0000-4000-8000-000000000002', 'item_payee_3d') $$,
  'Andere Erinnerungsart für dieselbe Person/denselben Posten ist erlaubt');

SELECT throws_ok(
  $$ INSERT INTO prepayment_item_reminder_log(trip_id, item_id, person_id, reminder_type) VALUES
     ('61610000-0000-4000-8000-0000000000aa', '61610000-0000-4000-8000-0000000000d1',
      '61610000-0000-4000-8000-000000000003', 'crew_3d') $$,
  '23514', NULL, 'CHECK: nur item_crew_3d / item_payee_3d');

SELECT throws_ok(
  $$ INSERT INTO prepayment_item_reminder_log(trip_id, item_id, person_id, reminder_type) VALUES
     ('61610000-0000-4000-8000-0000000000bb', '61610000-0000-4000-8000-0000000000d1',
      '61610000-0000-4000-8000-000000000001', 'item_crew_3d') $$,
  '23503', NULL, 'Composite-FK: kein Log-Eintrag mit Posten eines anderen Törns');

-- ── 3. CASCADE beim Löschen des Postens ───────────────────────────────
DELETE FROM prepayment_items WHERE id = '61610000-0000-4000-8000-0000000000d2';
SELECT is(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE item_id = '61610000-0000-4000-8000-0000000000d2'),
  0::bigint, 'Gelöschter Posten nimmt seine Log-Zeilen mit');
SELECT is(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE item_id = '61610000-0000-4000-8000-0000000000d1'),
  4::bigint, 'Log-Zeilen anderer Posten bleiben');

-- ── 4a. Purge ─────────────────────────────────────────────────────────
-- Hinweis: purge_trip_data löscht danach auch die Posten, deren CASCADE die
-- Log-Zeilen ebenfalls entfernt. Der Check belegt das ERGEBNIS (kein Log
-- bleibt), nicht speziell die explizite DELETE-Zeile aus 0061 — die ist
-- bewusst redundant (Gürtel für einen späteren Umbau des Posten-Deletes).
SELECT is(
  purge_trip_data('61610000-0000-4000-8000-0000000000bb', FALSE),
  'ok', 'Purge eines Törns mit Posten-Erinnerungen läuft durch');
SELECT is(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE trip_id = '61610000-0000-4000-8000-0000000000bb'),
  0::bigint, 'Purge löscht das Posten-Erinnerungs-Log des Törns');
SELECT is(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE trip_id = '61610000-0000-4000-8000-0000000000aa'),
  4::bigint, 'Log anderer Törns bleibt beim Purge unberührt');

-- ── 4b. admin_delete_person_data ──────────────────────────────────────
-- Crew A hat keine Buchungen und ist kein Empfänger → Löschung erlaubt.
SELECT is(
  admin_delete_person_data('61610000-0000-4000-8000-000000000002'),
  'ok', 'admin_delete_person_data läuft durch');
SELECT is(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE person_id = '61610000-0000-4000-8000-000000000002'),
  0::bigint, 'admin_delete_person_data löscht das Posten-Erinnerungs-Log der Person');

-- ── 4c. delete_my_account (Altpfad über auth.uid()) ───────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '61610000-0000-4000-8000-0000000000f2')::text, TRUE);
-- Eigene Statements: Unterabfragen im SELECT des Aufrufs sähen noch den
-- Snapshot von VOR dem Löschen.
SELECT is(delete_my_account(), 'ok', 'delete_my_account läuft durch');
SELECT ok(
  (SELECT count(*) FROM prepayment_item_reminder_log WHERE person_id = '61610000-0000-4000-8000-000000000003') = 0
  AND (SELECT count(*) FROM prepayment_item_reminder_log WHERE person_id = '61610000-0000-4000-8000-000000000001') = 1,
  'delete_my_account löscht das Log der Person, das des Empfängers bleibt');

SELECT * FROM finish();
ROLLBACK;
