-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Q4 + Q6 (Migration 0043)
--
-- Q4: v_balances zählte unbestätigte Pending-Selbstmeldungen
--     (confirmed_at IS NULL) sofort als credit_given/credit_received →
--     falscher Gesamt-Saldo in der Abrechnungs-Mail. Nach dem Fix zählt nur
--     Bestätigtes.
-- Q6: bump_login_rate_limit darf nicht mehr für anon/authenticated
--     ausführbar sein (nur service_role).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(5);

-- ── Setup: 2-Personen-Törn mit Anzahlungsplan + einer Tranche ─────────
INSERT INTO persons(id, display_name) VALUES
  ('43430000-0000-4000-8000-000000000001', 'Pending P1'),
  ('43430000-0000-4000-8000-000000000002', 'Pending P2');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('43430000-0000-4000-8000-0000000000aa', 'pgTAP Pending-Credit',
   '2026-06-01', '2026-06-10', '43430000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('43430000-0000-4000-8000-0000000000aa', '43430000-0000-4000-8000-000000000001'),
  ('43430000-0000-4000-8000-0000000000aa', '43430000-0000-4000-8000-000000000002');

INSERT INTO prepayment_plan(trip_id, split_method, total_amount, advancer_person_id) VALUES
  ('43430000-0000-4000-8000-0000000000aa', 'gleichmaessig', 200,
   '43430000-0000-4000-8000-000000000001');

INSERT INTO prepayment_tranches(id, trip_id, label, percent, due_date) VALUES
  ('43430000-0000-4000-8000-0000000000d1', '43430000-0000-4000-8000-0000000000aa',
   'Endzahlung', 100, '2026-05-20');

-- P2 meldet selbst „Ich habe gezahlt" (100 € an Vorstrecker P1), noch
-- UNBESTÄTIGT → confirmed_at NULL, tranche-getaggt (wie submitSelfPayment).
INSERT INTO transactions(id, trip_id, type, date, description, amount,
                         credit_from, credit_to, tranche_id, confirmed_at) VALUES
  ('43430000-0000-4000-8000-0000000000e1', '43430000-0000-4000-8000-0000000000aa',
   'credit', '2026-05-15', 'Selbstmeldung', 100,
   '43430000-0000-4000-8000-000000000002', '43430000-0000-4000-8000-000000000001',
   '43430000-0000-4000-8000-0000000000d1', NULL);

-- ── Q4 Check 1+2: Pending zählt NICHT in v_balances ───────────────────
SELECT is(
  (SELECT round(COALESCE(credit_given, 0), 2) FROM v_balances
   WHERE trip_id = '43430000-0000-4000-8000-0000000000aa'
     AND person_id = '43430000-0000-4000-8000-000000000002'),
  0.00::numeric, 'Q4: unbestätigte Selbstmeldung zählt NICHT als credit_given (P2)');

SELECT is(
  (SELECT round(COALESCE(SUM(balance), 0), 2) FROM v_balances
   WHERE trip_id = '43430000-0000-4000-8000-0000000000aa'),
  0.00::numeric, 'Q4: Saldensumme bleibt 0 trotz Pending-Meldung');

-- ── Q4 Check 3: nach Bestätigung zählt es sehr wohl ───────────────────
UPDATE transactions SET confirmed_at = now()
WHERE id = '43430000-0000-4000-8000-0000000000e1';

SELECT is(
  (SELECT round(COALESCE(credit_given, 0), 2) FROM v_balances
   WHERE trip_id = '43430000-0000-4000-8000-0000000000aa'
     AND person_id = '43430000-0000-4000-8000-000000000002'),
  100.00::numeric, 'Q4: bestätigte Zahlung zählt als credit_given (P2 = 100)');

-- ── Q6 Check 4+5: bump_login_rate_limit für anon/authenticated gesperrt ─
SELECT is(
  has_function_privilege('anon', 'bump_login_rate_limit(text, int, int)', 'execute'),
  false, 'Q6: anon darf bump_login_rate_limit NICHT ausführen');

SELECT is(
  has_function_privilege('authenticated', 'bump_login_rate_limit(text, int, int)', 'execute'),
  false, 'Q6: authenticated darf bump_login_rate_limit NICHT ausführen');

SELECT * FROM finish();
ROLLBACK;
