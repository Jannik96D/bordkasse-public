-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0051 (Sanierungsplan 2026-09, PR 2):
-- `admin_delete_person_data(p_person_id)` löscht/anonymisiert die
-- übergebene Person unabhängig von `auth.uid()` (siehe Migrations-
-- Kommentar für den Produktionsdefekt der alten `delete_my_account()`,
-- den pgTAP als Superuser ohne JWT-Kontext nicht reproduzieren kann —
-- diese Datei prüft deshalb NUR die Wirkung der neuen Function, nicht
-- den alten Bug selbst).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(10);

-- ── Fall A: Person ohne aktive Buchungen → volle Löschung ──────────────
INSERT INTO auth.users(id) VALUES ('51510000-0000-4000-8000-0000000000f1');
INSERT INTO persons(id, display_name, auth_user_id, is_alcoholic) VALUES
  ('51510000-0000-4000-8000-000000000001', 'Delete-Test Person A', '51510000-0000-4000-8000-0000000000f1', TRUE);
INSERT INTO persons_private(person_id, last_name, email) VALUES
  ('51510000-0000-4000-8000-000000000001', 'Nachname', 'delete-a@example.test');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('51510000-0000-4000-8000-0000000000aa', 'pgTAP Admin-Delete (vergangen)',
   '2020-01-01', '2020-01-10', '51510000-0000-4000-8000-000000000001');
INSERT INTO trip_members(trip_id, person_id, is_skipper) VALUES
  ('51510000-0000-4000-8000-0000000000aa', '51510000-0000-4000-8000-000000000001', TRUE);

INSERT INTO audit_log(trip_id, actor_person_id, table_name, operation, payload) VALUES
  ('51510000-0000-4000-8000-0000000000aa', '51510000-0000-4000-8000-000000000001',
   'transactions', 'INSERT', '{}'::jsonb);

SELECT is(
  admin_delete_person_data('51510000-0000-4000-8000-000000000001'),
  'ok', 'Löschung ohne aktive Buchungen liefert ok');

SELECT is(
  (SELECT display_name FROM persons WHERE id = '51510000-0000-4000-8000-000000000001'),
  'Ehemaliges Crew-Mitglied', 'persons-Row wird anonymisiert');

SELECT is(
  (SELECT auth_user_id FROM persons WHERE id = '51510000-0000-4000-8000-000000000001'),
  NULL::uuid, 'auth_user_id wird gekappt');

SELECT is(
  (SELECT is_alcoholic FROM persons WHERE id = '51510000-0000-4000-8000-000000000001'),
  FALSE, 'is_alcoholic wird zurückgesetzt');

SELECT is(
  (SELECT count(*) FROM persons_private WHERE person_id = '51510000-0000-4000-8000-000000000001'),
  0::bigint, 'persons_private wird gelöscht');

SELECT is(
  (SELECT actor_person_id FROM audit_log
    WHERE trip_id = '51510000-0000-4000-8000-0000000000aa' AND table_name = 'transactions'),
  NULL::uuid, 'audit_log.actor_person_id wird genullt (Zeile bleibt erhalten — Append-only)');

SELECT is(
  (SELECT count(*) FROM trip_members
    WHERE trip_id = '51510000-0000-4000-8000-0000000000aa'
      AND person_id = '51510000-0000-4000-8000-000000000001'),
  0::bigint, 'Pre-Trip-Mitgliedschaft ohne Buchungs-Spur wird entfernt');

-- ── Fall B: Person MIT Buchung in aktivem Trip → Löschung blockiert ────
INSERT INTO auth.users(id) VALUES ('51510000-0000-4000-8000-0000000000f2');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('51510000-0000-4000-8000-000000000002', 'Delete-Test Person B', '51510000-0000-4000-8000-0000000000f2');
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('51510000-0000-4000-8000-0000000000bb', 'pgTAP Admin-Delete (aktiv)',
   CURRENT_DATE, CURRENT_DATE + 5, '51510000-0000-4000-8000-000000000002');
INSERT INTO trip_members(trip_id, person_id, is_skipper) VALUES
  ('51510000-0000-4000-8000-0000000000bb', '51510000-0000-4000-8000-000000000002', TRUE);
INSERT INTO transactions(trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('51510000-0000-4000-8000-0000000000bb', 'expense', CURRENT_DATE, 'Aktive Buchung', 20,
   '51510000-0000-4000-8000-000000000002', 'equal');

SELECT is(
  admin_delete_person_data('51510000-0000-4000-8000-000000000002'),
  'has_active_bookings', 'Löschung mit Buchung in aktivem Trip wird abgewiesen');

SELECT is(
  (SELECT display_name FROM persons WHERE id = '51510000-0000-4000-8000-000000000002'),
  'Delete-Test Person B', 'Person B bleibt unangetastet, wenn der Blocker greift');

-- ── Gegenprobe: kein EXECUTE für anon/authenticated ────────────────────
SELECT ok(
  NOT has_function_privilege('authenticated', 'admin_delete_person_data(uuid)', 'EXECUTE'),
  'authenticated darf admin_delete_person_data nicht direkt aufrufen (nur service_role, App-Layer autorisiert)');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
