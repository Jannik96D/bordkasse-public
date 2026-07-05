-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Q1 (Migration 0042): v_balances_bordkasse_only
-- duplizierte Personen-Zeilen, wenn eine Person eine DIREKTE Gutschrift
-- UND (von jemand anderem) eine „An Alle"-Gutschrift erhält.
--
-- Vor dem Fix: die credit_received-UNION-ALL wurde nicht re-aggregiert →
-- FULL OUTER JOIN emittierte zwei Zeilen für die betroffene Person, jede
-- mit vollem paid/share/credit_given → simplify_debts zählte doppelt.
--
-- Wächter: (1) genau EINE Zeile pro Person in der View,
--          (2) Saldensumme über den Törn = 0,
--          (3) simplify_debts erzeugt keine Phantom-Überweisung.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(4);

-- ── Setup: 3-Personen-Törn ────────────────────────────────────────────
-- P1 zahlt 90 € gleichmäßig (je 30). Danach zwei Bordkasse-Gutschriften:
--   • P2 → P3 direkt 30 € (P3 landet im credit_received_direct-Zweig)
--   • P1 → „An Alle" 30 € (verteilt auf P2 & P3 → P3 auch im -alle-Zweig)
-- P3 taucht damit in BEIDEN credit_received-Zweigen auf = der Bug-Trigger.
INSERT INTO persons(id, display_name) VALUES
  ('42420000-0000-4000-8000-000000000001', 'Dedup P1'),
  ('42420000-0000-4000-8000-000000000002', 'Dedup P2'),
  ('42420000-0000-4000-8000-000000000003', 'Dedup P3');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('42420000-0000-4000-8000-0000000000aa', 'pgTAP Credit-Dedup',
   '2026-05-01', '2026-05-10', '42420000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('42420000-0000-4000-8000-0000000000aa', '42420000-0000-4000-8000-000000000001'),
  ('42420000-0000-4000-8000-0000000000aa', '42420000-0000-4000-8000-000000000002'),
  ('42420000-0000-4000-8000-0000000000aa', '42420000-0000-4000-8000-000000000003');

-- Ausgabe 90 € gleichmäßig, von P1 bezahlt.
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('42420000-0000-4000-8000-0000000000e1', '42420000-0000-4000-8000-0000000000aa',
   'expense', '2026-05-02', 'Essen', 90, '42420000-0000-4000-8000-000000000001', 'equal');

-- Direkte Gutschrift P2 → P3, 30 €.
INSERT INTO transactions(id, trip_id, type, date, description, amount, credit_from, credit_to) VALUES
  ('42420000-0000-4000-8000-0000000000e2', '42420000-0000-4000-8000-0000000000aa',
   'credit', '2026-05-03', 'Direkt', 30,
   '42420000-0000-4000-8000-000000000002', '42420000-0000-4000-8000-000000000003');

-- „An Alle"-Gutschrift von P1, 30 € (→ je 15 an P2 & P3).
INSERT INTO transactions(id, trip_id, type, date, description, amount, credit_from, credit_to) VALUES
  ('42420000-0000-4000-8000-0000000000e3', '42420000-0000-4000-8000-0000000000aa',
   'credit', '2026-05-04', 'An Alle', 30,
   '42420000-0000-4000-8000-000000000001', NULL);

-- ── Check 1: P3 hat GENAU EINE Zeile (vor Fix: zwei) ──────────────────
SELECT is(
  (SELECT count(*) FROM v_balances_bordkasse_only
   WHERE trip_id = '42420000-0000-4000-8000-0000000000aa'
     AND person_id = '42420000-0000-4000-8000-000000000003'),
  1::bigint, 'P3 erscheint genau einmal in v_balances_bordkasse_only');

-- ── Check 2: P3 credit_received = 30 (direkt) + 15 (an alle) = 45 ─────
SELECT is(
  (SELECT round(credit_received, 2) FROM v_balances_bordkasse_only
   WHERE trip_id = '42420000-0000-4000-8000-0000000000aa'
     AND person_id = '42420000-0000-4000-8000-000000000003'),
  45.00::numeric, 'P3 credit_received = 45 (beide Zweige summiert)');

-- ── Check 3: Saldensumme über alle Personen = 0 ───────────────────────
SELECT is(
  (SELECT round(SUM(balance), 2) FROM v_balances_bordkasse_only
   WHERE trip_id = '42420000-0000-4000-8000-0000000000aa'),
  0.00::numeric, 'Bordkasse-Saldensumme = 0 (keine Doppelzählung)');

-- ── Check 4: simplify_debts erzeugt keine überzähligen Überweisungen ──
-- Salden (balance = paid + credit_given − share − credit_received):
--   P1 = 90 + 30(an alle) − 30 − 0            = +90
--   P2 =  0 + 30(direkt)  − 30 − 15(an alle)  = −15
--   P3 =  0 +  0          − 30 − 45           = −75
-- ⇒ ein Gläubiger (P1 +90), zwei Schuldner (P2 −15, P3 −75) → 2 Transfers.
-- Vor dem Fix hätte die P3-Doppelzeile die Salden verfälscht.
SELECT is(
  (SELECT count(*) FROM simplify_debts('42420000-0000-4000-8000-0000000000aa')),
  2::bigint, 'simplify_debts: genau 2 Überweisungen, keine Phantom-Transfers');

SELECT * FROM finish();
ROLLBACK;
