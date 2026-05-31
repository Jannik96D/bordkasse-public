-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Bug: Soft-gelöschte Buchungen verfälschen Bilanz
--
-- Vor dem Fix (Migration 0032_balances_filter_deleted): v_balances und
-- v_transaction_shares filterten deleted_at NICHT → eine gelöschte Buchung
-- blieb in der Bilanz (Bilanz-Seite + Saldo-Zeile der Abrechnungs-Mails).
--
-- Checks 4+5 sind die eigentlichen Regressions-Wächter (v_balances).
-- Checks 3+6 (simplify_debts) sind bereits OHNE Fix grün — simplify_debts
-- liest v_balances_bordkasse_only und war nie betroffen; sie bleiben als
-- Invarianten-Doku drin.
--
-- Lauf: cd webapp && supabase test db
-- (pgTAP wird vom Supabase-Runner geladen; jede Datei kapselt sich selbst.)
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(6);

-- ── Setup: 2-Personen-Törn, 100 € gleichmäßig, von P1 bezahlt ──────────
INSERT INTO persons(id, display_name) VALUES
  ('32320000-0000-4000-8000-000000000001', 'SoftDelete P1'),
  ('32320000-0000-4000-8000-000000000002', 'SoftDelete P2');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('32320000-0000-4000-8000-0000000000aa', 'pgTAP Soft-Delete',
   '2026-04-05', '2026-04-15', '32320000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('32320000-0000-4000-8000-0000000000aa', '32320000-0000-4000-8000-000000000001'),
  ('32320000-0000-4000-8000-0000000000aa', '32320000-0000-4000-8000-000000000002');

INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('32320000-0000-4000-8000-0000000000e1', '32320000-0000-4000-8000-0000000000aa',
   'expense', '2026-04-06', 'wird gelöscht', 100, '32320000-0000-4000-8000-000000000001', 'equal');

-- ── Vorher: Bilanz +50 / -50, genau 1 Überweisung ────────────────────
SELECT is(
  (SELECT round(balance, 2) FROM v_balances
   WHERE trip_id = '32320000-0000-4000-8000-0000000000aa'
     AND person_id = '32320000-0000-4000-8000-000000000001'),
  50.00::numeric, 'vor Delete: Zahler P1 = +50');

SELECT is(
  (SELECT round(balance, 2) FROM v_balances
   WHERE trip_id = '32320000-0000-4000-8000-0000000000aa'
     AND person_id = '32320000-0000-4000-8000-000000000002'),
  -50.00::numeric, 'vor Delete: P2 = -50');

SELECT is(
  (SELECT count(*) FROM simplify_debts('32320000-0000-4000-8000-0000000000aa')),
  1::bigint, 'vor Delete: 1 Überweisung');

-- ── Soft-Delete ──────────────────────────────────────────────────────
UPDATE transactions SET deleted_at = now()
WHERE id = '32320000-0000-4000-8000-0000000000e1';

-- ── Nachher: gelöschte Buchung darf NICHT mehr zählen ─────────────────
SELECT is(
  (SELECT round(balance, 2) FROM v_balances
   WHERE trip_id = '32320000-0000-4000-8000-0000000000aa'
     AND person_id = '32320000-0000-4000-8000-000000000001'),
  0.00::numeric, 'nach Delete: P1 = 0 (Buchung ignoriert)');

SELECT is(
  (SELECT round(balance, 2) FROM v_balances
   WHERE trip_id = '32320000-0000-4000-8000-0000000000aa'
     AND person_id = '32320000-0000-4000-8000-000000000002'),
  0.00::numeric, 'nach Delete: P2 = 0 (Buchung ignoriert)');

SELECT is(
  (SELECT count(*) FROM simplify_debts('32320000-0000-4000-8000-0000000000aa')),
  0::bigint, 'nach Delete: keine Überweisung mehr');

SELECT * FROM finish();
ROLLBACK;
