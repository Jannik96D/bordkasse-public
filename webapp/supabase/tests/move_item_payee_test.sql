-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0059: move_item_payee (Empfängerwechsel eines Postens)
--
-- Geprüft:
--   A. Rechte: nur service_role darf die Funktion ausführen.
--   B. Wechsel mit hängenden Gutschriften (bestätigt, offen, Selbst-
--      verrechnung alt→alt, Gutschrift neu→alt, soft-gelöscht):
--        • payee_person_id und credit_to wandern (fachliche Entscheidung:
--          Altzahlungen gehen zum neuen Empfänger)
--        • offene Selbstmeldung bleibt offen
--        • v_prepayment_item_payments je Zahler unverändert
--        • Σ v_balances bleibt 0
--        • Anbieter-Ausgabe (paid_by) bleibt unangetastet
--   C. Trigger bleiben scharf: direktes UPDATE von payee_person_id scheitert
--      weiterhin (auch NACH dem Funktionsaufruf in derselben Transaktion —
--      das Flag leckt nicht), ein auf einen ANDEREN Posten gesetztes Flag
--      öffnet diesen Posten nicht, eine neue Gutschrift an den ALTEN
--      Empfänger wird abgewiesen.
--   D. Idempotenz + Fehlerfälle (gleicher Empfänger → 0, unbekannte
--      Person / unbekannter Posten → P0001).
--
-- Lauf: docker exec -i supabase_db_bordkasse psql -U postgres -d postgres \
--         < supabase/tests/move_item_payee_test.sql   (oder pnpm test:db)
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(20);

-- ── Setup ─────────────────────────────────────────────────────────────
INSERT INTO persons(id, display_name) VALUES
  ('59590000-0000-4000-8000-000000000001', 'Alt-Empfänger'),
  ('59590000-0000-4000-8000-000000000002', 'Neu-Empfänger'),
  ('59590000-0000-4000-8000-000000000003', 'Crew C');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('59590000-0000-4000-8000-0000000000aa', 'pgTAP Empfängerwechsel', '2027-05-01', '2027-05-10',
   '59590000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000001'),
  ('59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000002'),
  ('59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000003');

INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type) VALUES
  ('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-0000000000aa',
   'Flüge', 300, '59590000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('59590000-0000-4000-8000-0000000000d2', '59590000-0000-4000-8000-0000000000aa',
   'Bahn', 90, '59590000-0000-4000-8000-000000000001', 'gleichmaessig');

INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount) VALUES
  ('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000001', 100),
  ('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000002', 100),
  ('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-0000000000aa', '59590000-0000-4000-8000-000000000003', 100);

-- Anbieter-Zahlung des alten Empfängers (per_person = Soll).
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type, item_id) VALUES
  ('59590000-0000-4000-8000-000000000101', '59590000-0000-4000-8000-0000000000aa', 'expense',
   '2027-03-01', 'Flüge', 300, '59590000-0000-4000-8000-000000000001', 'per_person',
   '59590000-0000-4000-8000-0000000000d1');
INSERT INTO transaction_participants(transaction_id, person_id, amount) VALUES
  ('59590000-0000-4000-8000-000000000101', '59590000-0000-4000-8000-000000000001', 100),
  ('59590000-0000-4000-8000-000000000101', '59590000-0000-4000-8000-000000000002', 100),
  ('59590000-0000-4000-8000-000000000101', '59590000-0000-4000-8000-000000000003', 100);

-- Gutschriften: Selbstverrechnung alt→alt, neu→alt (bestätigt), C→alt
-- (offen), C→alt (soft-gelöscht).
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id, confirmed_at, deleted_at) VALUES
  ('59590000-0000-4000-8000-000000000201', '59590000-0000-4000-8000-0000000000aa', 'credit', '2027-03-02', 100,
   '59590000-0000-4000-8000-000000000001', '59590000-0000-4000-8000-000000000001',
   '59590000-0000-4000-8000-0000000000d1', now(), NULL),
  ('59590000-0000-4000-8000-000000000202', '59590000-0000-4000-8000-0000000000aa', 'credit', '2027-03-02', 100,
   '59590000-0000-4000-8000-000000000002', '59590000-0000-4000-8000-000000000001',
   '59590000-0000-4000-8000-0000000000d1', now(), NULL),
  ('59590000-0000-4000-8000-000000000203', '59590000-0000-4000-8000-0000000000aa', 'credit', '2027-03-03', 100,
   '59590000-0000-4000-8000-000000000003', '59590000-0000-4000-8000-000000000001',
   '59590000-0000-4000-8000-0000000000d1', NULL, NULL),
  ('59590000-0000-4000-8000-000000000204', '59590000-0000-4000-8000-0000000000aa', 'credit', '2027-03-03', 50,
   '59590000-0000-4000-8000-000000000003', '59590000-0000-4000-8000-000000000001',
   '59590000-0000-4000-8000-0000000000d1', now(), now());

-- ── A. Rechte ─────────────────────────────────────────────────────────
SELECT ok(NOT has_function_privilege('anon', 'move_item_payee(uuid, uuid)', 'EXECUTE'),
  'A1: anon darf move_item_payee nicht ausführen');
SELECT ok(NOT has_function_privilege('authenticated', 'move_item_payee(uuid, uuid)', 'EXECUTE'),
  'A2: authenticated darf move_item_payee nicht ausführen');
SELECT ok(has_function_privilege('service_role', 'move_item_payee(uuid, uuid)', 'EXECUTE'),
  'A3: service_role darf move_item_payee ausführen');

-- ── C (vorab). Ohne Funktion bleibt der Wechsel gesperrt ──────────────
SELECT throws_ok(
  $$UPDATE prepayment_items SET payee_person_id = '59590000-0000-4000-8000-000000000002'
     WHERE id = '59590000-0000-4000-8000-0000000000d1'$$,
  'P0001', 'prepayment_item_payee_has_credits',
  'C1: direkter Empfängerwechsel mit hängenden Gutschriften bleibt verboten');

-- Ein Flag für einen ANDEREN Posten öffnet diesen Posten nicht.
SELECT set_config('bordkasse.item_payee_move', '59590000-0000-4000-8000-0000000000d2', true);
SELECT throws_ok(
  $$UPDATE prepayment_items SET payee_person_id = '59590000-0000-4000-8000-000000000002'
     WHERE id = '59590000-0000-4000-8000-0000000000d1'$$,
  'P0001', 'prepayment_item_payee_has_credits',
  'C2: ein Flag für einen anderen Posten umgeht den Schutz nicht');
SELECT set_config('bordkasse.item_payee_move', '', true);

-- Soll-Stand vor dem Wechsel (Bezahlt je Zahler).
CREATE TEMP TABLE before_paid AS
  SELECT person_id, paid_amount FROM v_prepayment_item_payments
   WHERE item_id = '59590000-0000-4000-8000-0000000000d1';

-- ── B. Wechsel ────────────────────────────────────────────────────────
SELECT is(
  move_item_payee('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-000000000002'),
  4,
  'B1: alle vier Gutschriften an den alten Empfänger werden umgehängt (inkl. offen + soft-gelöscht)');

SELECT is(
  (SELECT payee_person_id FROM prepayment_items WHERE id = '59590000-0000-4000-8000-0000000000d1'),
  '59590000-0000-4000-8000-000000000002'::uuid,
  'B2: payee_person_id zeigt auf den neuen Empfänger');

SELECT is(
  (SELECT count(*)::int FROM transactions
    WHERE item_id = '59590000-0000-4000-8000-0000000000d1' AND type = 'credit'
      AND credit_to <> '59590000-0000-4000-8000-000000000002'),
  0,
  'B3: keine Posten-Gutschrift geht mehr an den alten Empfänger');

SELECT is(
  (SELECT confirmed_at FROM transactions WHERE id = '59590000-0000-4000-8000-000000000203'),
  NULL,
  'B4: die offene Selbstmeldung bleibt offen');

SELECT is(
  (SELECT credit_from::text || '>' || credit_to::text FROM transactions WHERE id = '59590000-0000-4000-8000-000000000201'),
  '59590000-0000-4000-8000-000000000001>59590000-0000-4000-8000-000000000002',
  'B5: Selbstverrechnung alt→alt wird zur Zahlung alt→neu');

SELECT is(
  (SELECT credit_from::text || '>' || credit_to::text FROM transactions WHERE id = '59590000-0000-4000-8000-000000000202'),
  '59590000-0000-4000-8000-000000000002>59590000-0000-4000-8000-000000000002',
  'B6: Gutschrift neu→alt wird zur Selbstverrechnung neu→neu');

SELECT set_eq(
  $$SELECT person_id, paid_amount FROM v_prepayment_item_payments
     WHERE item_id = '59590000-0000-4000-8000-0000000000d1'$$,
  $$SELECT person_id, paid_amount FROM before_paid$$,
  'B7: „bezahlt" je Zahler ist unverändert (Altzahlungen zählen weiter)');

SELECT is(
  (SELECT ROUND(SUM(balance), 2) FROM v_balances WHERE trip_id = '59590000-0000-4000-8000-0000000000aa'),
  0.00::numeric,
  'B8: Σ v_balances bleibt 0');

SELECT is(
  (SELECT paid_by FROM transactions WHERE id = '59590000-0000-4000-8000-000000000101'),
  '59590000-0000-4000-8000-000000000001'::uuid,
  'B9: Anbieter-Ausgabe des alten Empfängers bleibt unangetastet');

-- ── C. Trigger bleiben scharf, Flag leckt nicht ───────────────────────
SELECT throws_ok(
  $$UPDATE prepayment_items SET payee_person_id = '59590000-0000-4000-8000-000000000003'
     WHERE id = '59590000-0000-4000-8000-0000000000d1'$$,
  'P0001', 'prepayment_item_payee_has_credits',
  'C3: nach dem Funktionsaufruf (gleiche Transaktion) ist der direkte Wechsel wieder gesperrt');

SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id)
    VALUES ('59590000-0000-4000-8000-0000000000aa', 'credit', '2027-03-04', 10,
            '59590000-0000-4000-8000-000000000003', '59590000-0000-4000-8000-000000000001',
            '59590000-0000-4000-8000-0000000000d1')$$,
  'P0001', 'prepayment_item_credit_wrong_payee',
  'C4: eine neue Gutschrift an den ALTEN Empfänger wird abgewiesen');

-- ── D. Idempotenz + Fehlerfälle ───────────────────────────────────────
SELECT is(
  move_item_payee('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-000000000002'),
  0,
  'D1: erneuter Aufruf mit demselben Empfänger ist ein No-Op (Retry-sicher)');

SELECT throws_ok(
  $$SELECT move_item_payee('59590000-0000-4000-8000-0000000000d1', '59590000-0000-4000-8000-0000000009ff')$$,
  'P0001', 'prepayment_item_payee_invalid',
  'D2: unbekannte Person als Empfänger wird abgewiesen');

SELECT throws_ok(
  $$SELECT move_item_payee('59590000-0000-4000-8000-0000000009fe', '59590000-0000-4000-8000-000000000002')$$,
  'P0001', 'prepayment_item_not_found',
  'D3: unbekannter Posten wird abgewiesen');

-- Posten ohne Gutschriften: Wechsel funktioniert auch ohne Funktion, die
-- Funktion selbst liefert 0 umgehängte Zeilen.
SELECT is(
  move_item_payee('59590000-0000-4000-8000-0000000000d2', '59590000-0000-4000-8000-000000000003'),
  0,
  'D4: Posten ohne Gutschriften — Wechsel ohne umzuhängende Zeilen');

SELECT * FROM finish();
ROLLBACK;
