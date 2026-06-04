-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu S-1: Views umgingen RLS (unauth. Datenleak)
--
-- Vor Migration 0035 liefen alle Views mit Definer-Rechten (BYPASSRLS) →
-- der anon-Key konnte über die REST-API Finanzdaten aller Törns lesen.
-- 0035 stellt sie auf security_invoker=on und entzieht anon das SELECT.
--
-- Diese Datei wacht über beide Garantien:
--   1. Katalog: security_invoker ist auf allen 6 Views gesetzt.
--   2. Katalog: anon hat KEIN SELECT-Recht mehr auf die Views.
--   3. Funktional: ein authenticated-User OHNE Mitgliedschaft (auth.uid()
--      = NULL, da kein JWT) bekommt über v_balances 0 Zeilen, während die
--      Definer-Rolle die Daten sehr wohl sieht (beweist: RLS filtert).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(14);

-- ── 1. security_invoker auf allen 6 Views gesetzt ─────────────────────
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_balances') @> ARRAY['security_invoker=on'],
  'v_balances: security_invoker=on');
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_transaction_shares') @> ARRAY['security_invoker=on'],
  'v_transaction_shares: security_invoker=on');
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_balances_bordkasse_only') @> ARRAY['security_invoker=on'],
  'v_balances_bordkasse_only: security_invoker=on');
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_prepayment_payments') @> ARRAY['security_invoker=on'],
  'v_prepayment_payments: security_invoker=on');
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_prepayment_pending') @> ARRAY['security_invoker=on'],
  'v_prepayment_pending: security_invoker=on');
SELECT ok(
  (SELECT reloptions FROM pg_class WHERE relname = 'v_trip_members_with_days') @> ARRAY['security_invoker=on'],
  'v_trip_members_with_days: security_invoker=on');

-- ── 2. anon hat KEIN SELECT mehr auf die Views ────────────────────────
SELECT ok(NOT has_table_privilege('anon', 'v_balances', 'SELECT'),
  'anon: kein SELECT auf v_balances');
SELECT ok(NOT has_table_privilege('anon', 'v_transaction_shares', 'SELECT'),
  'anon: kein SELECT auf v_transaction_shares');
SELECT ok(NOT has_table_privilege('anon', 'v_balances_bordkasse_only', 'SELECT'),
  'anon: kein SELECT auf v_balances_bordkasse_only');
SELECT ok(NOT has_table_privilege('anon', 'v_prepayment_payments', 'SELECT'),
  'anon: kein SELECT auf v_prepayment_payments');
SELECT ok(NOT has_table_privilege('anon', 'v_prepayment_pending', 'SELECT'),
  'anon: kein SELECT auf v_prepayment_pending');
SELECT ok(NOT has_table_privilege('anon', 'v_trip_members_with_days', 'SELECT'),
  'anon: kein SELECT auf v_trip_members_with_days');

-- ── 3. Funktional: RLS filtert für nicht-Mitglieder ───────────────────
-- Setup als Definer-Rolle (BYPASSRLS): 2-Personen-Törn, 100 € gleichmäßig.
INSERT INTO persons(id, display_name) VALUES
  ('51510000-0000-4000-8000-000000000001', 'SecInv P1'),
  ('51510000-0000-4000-8000-000000000002', 'SecInv P2');
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('51510000-0000-4000-8000-0000000000aa', 'pgTAP SecInvoker',
   '2026-04-05', '2026-04-15', '51510000-0000-4000-8000-000000000001');
INSERT INTO trip_members(trip_id, person_id) VALUES
  ('51510000-0000-4000-8000-0000000000aa', '51510000-0000-4000-8000-000000000001'),
  ('51510000-0000-4000-8000-0000000000aa', '51510000-0000-4000-8000-000000000002');
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('51510000-0000-4000-8000-0000000000e1', '51510000-0000-4000-8000-0000000000aa',
   'expense', '2026-04-06', 'Definer sieht das', 100,
   '51510000-0000-4000-8000-000000000001', 'equal');

-- Definer-Rolle (BYPASSRLS) sieht beide Salden-Zeilen.
SELECT is(
  (SELECT count(*) FROM v_balances
   WHERE trip_id = '51510000-0000-4000-8000-0000000000aa'),
  2::bigint, 'Definer-Rolle sieht beide Salden (Daten existieren)');

-- authenticated ohne JWT → auth.uid() = NULL → keine Mitgliedschaft → 0 Zeilen.
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*) FROM v_balances
   WHERE trip_id = '51510000-0000-4000-8000-0000000000aa'),
  0::bigint, 'authenticated (kein Mitglied) sieht 0 Salden — RLS greift über die View');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
