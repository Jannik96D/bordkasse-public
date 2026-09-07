-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0049 (Sanierungsplan 2026-09, PR 0):
-- purge_trip_data / purge_expired_trip_data / all_debts_settled /
-- mark_post_settlement_change dürfen für `anon` und `authenticated` kein
-- EXECUTE mehr tragen (PostgreSQL vergibt das sonst implizit an PUBLIC).
-- Gegenprobe: simplify_debts bleibt für `authenticated` ausführbar, und
-- ein eingeloggtes Crewmitglied kann seine Törns weiterhin per RLS lesen —
-- beweist, dass die Policy-Helferfunktionen NICHT mitgesperrt wurden.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(10);

-- ── Die vier Purge-/Settlement-Funktionen: kein EXECUTE für anon/authenticated ──
SELECT ok(
  NOT has_function_privilege('anon', 'purge_trip_data(uuid, boolean)', 'EXECUTE'),
  'anon darf purge_trip_data nicht ausführen');
SELECT ok(
  NOT has_function_privilege('authenticated', 'purge_trip_data(uuid, boolean)', 'EXECUTE'),
  'authenticated darf purge_trip_data nicht ausführen');

SELECT ok(
  NOT has_function_privilege('anon', 'purge_expired_trip_data()', 'EXECUTE'),
  'anon darf purge_expired_trip_data nicht ausführen');
SELECT ok(
  NOT has_function_privilege('authenticated', 'purge_expired_trip_data()', 'EXECUTE'),
  'authenticated darf purge_expired_trip_data nicht ausführen');

SELECT ok(
  NOT has_function_privilege('anon', 'all_debts_settled(uuid)', 'EXECUTE'),
  'anon darf all_debts_settled nicht ausführen');
SELECT ok(
  NOT has_function_privilege('authenticated', 'all_debts_settled(uuid)', 'EXECUTE'),
  'authenticated darf all_debts_settled nicht ausführen');

SELECT ok(
  NOT has_function_privilege('anon', 'mark_post_settlement_change(uuid)', 'EXECUTE'),
  'anon darf mark_post_settlement_change nicht ausführen');
SELECT ok(
  NOT has_function_privilege('authenticated', 'mark_post_settlement_change(uuid)', 'EXECUTE'),
  'authenticated darf mark_post_settlement_change nicht ausführen');

-- ── Gegenprobe: simplify_debts bleibt für authenticated ausführbar ──────
SELECT ok(
  has_function_privilege('authenticated', 'simplify_debts(uuid)', 'EXECUTE'),
  'authenticated darf simplify_debts weiterhin ausführen (Cookie-Client, Schulden-Seite)');

-- ── Gegenprobe: Policy-Helfer nicht mitgesperrt — ein eingeloggtes
-- Mitglied liest seinen Törn weiterhin per RLS. ────────────────────────
INSERT INTO auth.users(id) VALUES ('49490000-0000-4000-8000-0000000000f1');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('49490000-0000-4000-8000-000000000001', 'Privileges-Test P1', '49490000-0000-4000-8000-0000000000f1');
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('49490000-0000-4000-8000-0000000000aa', 'pgTAP Function-Privileges',
   '2026-05-01', '2026-05-10', '49490000-0000-4000-8000-000000000001');
INSERT INTO trip_members(trip_id, person_id, is_skipper) VALUES
  ('49490000-0000-4000-8000-0000000000aa', '49490000-0000-4000-8000-000000000001', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '49490000-0000-4000-8000-0000000000f1')::text, TRUE);

SELECT is(
  (SELECT count(*) FROM trips WHERE id = '49490000-0000-4000-8000-0000000000aa'),
  1::bigint,
  'Skipper liest seinen eigenen Törn weiterhin per RLS (is_trip_skipper/-member nicht mitgesperrt)');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
