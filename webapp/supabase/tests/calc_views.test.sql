-- pgTAP-Tests gegen die echten Berechnungs-Views/Funktionen.
-- Ausführen lokal mit: supabase test db
--
-- Ergänzt den TS-Mirror (__tests__/calc.test.ts): hier wird die EManz SQL-
-- Logik (v_transaction_shares, v_balances, simplify_debts,
-- v_prepayment_payments) gegen Postgres geprüft, nicht nur die TS-Kopie.
--
-- Konvention (CLAUDE.md): Seed-UUIDs RFC-4122-valide — Versions-Nibble 4,
-- Variant 8. Alles in einer Transaktion, am Ende ROLLBACK → keine Spuren.

BEGIN;
SELECT plan(16);

-- ════════════════════════════════════════════════════════════════════════
-- TE — Gleichmäßig + Bilanz + Schulden (4 Crew, 5-Tage-Törn)
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name, is_alcoholic) VALUES
  ('aaaaaaa1-0000-4000-8000-0000000000a1', 'Anna TE',  FALSE),
  ('aaaaaaa1-0000-4000-8000-0000000000a2', 'Ben TE',   FALSE),
  ('aaaaaaa1-0000-4000-8000-0000000000a3', 'Carla TE', TRUE),
  ('aaaaaaa1-0000-4000-8000-0000000000a4', 'Diana TE', TRUE);

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa1-0000-4000-8000-000000000001', 'Törn TE', '2026-06-01', '2026-06-05',
   'aaaaaaa1-0000-4000-8000-0000000000a1');

INSERT INTO trip_members (trip_id, person_id) VALUES
  ('aaaaaaa1-0000-4000-8000-000000000001', 'aaaaaaa1-0000-4000-8000-0000000000a1'),
  ('aaaaaaa1-0000-4000-8000-000000000001', 'aaaaaaa1-0000-4000-8000-0000000000a2'),
  ('aaaaaaa1-0000-4000-8000-000000000001', 'aaaaaaa1-0000-4000-8000-0000000000a3'),
  ('aaaaaaa1-0000-4000-8000-000000000001', 'aaaaaaa1-0000-4000-8000-0000000000a4');

INSERT INTO transactions (id, trip_id, type, date, amount, paid_by, split_type) VALUES
  ('aaaaaaa1-0000-4000-8000-000000000010', 'aaaaaaa1-0000-4000-8000-000000000001',
   'expense', '2026-06-02', 100, 'aaaaaaa1-0000-4000-8000-0000000000a1', 'equal');

SELECT is(
  (SELECT ROUND(share, 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa1-0000-4000-8000-000000000010'
     AND person_id = 'aaaaaaa1-0000-4000-8000-0000000000a1'),
  25.00::numeric, 'Gleichmäßig: 100€/4 → Anteil 25€');

SELECT is(
  (SELECT ROUND(SUM(share), 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa1-0000-4000-8000-000000000010'),
  100.00::numeric, 'Gleichmäßig: Σ Anteile = Betrag');

SELECT is(
  (SELECT ROUND(balance, 2) FROM v_balances
   WHERE trip_id = 'aaaaaaa1-0000-4000-8000-000000000001'
     AND person_id = 'aaaaaaa1-0000-4000-8000-0000000000a1'),
  75.00::numeric, 'Bilanz: Zahler 100€ − 25€ Anteil = +75€');

SELECT is(
  (SELECT COUNT(*)::int FROM simplify_debts('aaaaaaa1-0000-4000-8000-000000000001')),
  3, 'Schulden: 3 Schuldner → 3 Überweisungen');

SELECT is(
  (SELECT ROUND(SUM(amount), 2) FROM simplify_debts('aaaaaaa1-0000-4000-8000-000000000001')),
  75.00::numeric, 'Schulden: Σ Transfers = Σ Forderung (75€), kein Cent verloren');

-- ════════════════════════════════════════════════════════════════════════
-- TO — "An Bord" mit 0 Anwesenden am Buchungs-Datum → keine Anteile
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name) VALUES
  ('aaaaaaa2-0000-4000-8000-0000000000a1', 'Anna TO'),
  ('aaaaaaa2-0000-4000-8000-0000000000a2', 'Ben TO');

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa2-0000-4000-8000-000000000001', 'Törn TO', '2026-06-01', '2026-06-05',
   'aaaaaaa2-0000-4000-8000-0000000000a1');

INSERT INTO trip_members (trip_id, person_id) VALUES
  ('aaaaaaa2-0000-4000-8000-000000000001', 'aaaaaaa2-0000-4000-8000-0000000000a1'),
  ('aaaaaaa2-0000-4000-8000-000000000001', 'aaaaaaa2-0000-4000-8000-0000000000a2');

-- Datum VOR Törn-Start → niemand an Bord.
INSERT INTO transactions (id, trip_id, type, date, amount, paid_by, split_type) VALUES
  ('aaaaaaa2-0000-4000-8000-000000000010', 'aaaaaaa2-0000-4000-8000-000000000001',
   'expense', '2026-05-01', 80, 'aaaaaaa2-0000-4000-8000-0000000000a1', 'on_board');

-- Hinweis: die SQL-View emittiert eine Zeile pro (Buchung × Crew) — auch für
-- nicht-aktive Personen, dann mit share=0 (anders als der TS-Mirror, der
-- share=0 wegfiltert). Maßgeblich ist: nichts wird allokiert (Σ = 0, kein
-- Anteil > 0), die Ausgabe „verschwindet" aus der Verteilung.
SELECT is(
  (SELECT COALESCE(ROUND(SUM(share), 2), 0) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa2-0000-4000-8000-000000000010'),
  0.00::numeric, 'An Bord ohne Anwesende: nichts allokiert (Σ Anteile = 0)');

SELECT is(
  (SELECT COUNT(*)::int FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa2-0000-4000-8000-000000000010'
     AND share > 0),
  0, 'An Bord ohne Anwesende: kein Anteil > 0');

-- ════════════════════════════════════════════════════════════════════════
-- TP — "Pro Person" + Alkohol: Σ = Betrag (Regression 0031, kein Doppel-Alk)
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name, is_alcoholic) VALUES
  ('aaaaaaa3-0000-4000-8000-0000000000a1', 'Anna TP',  FALSE),
  ('aaaaaaa3-0000-4000-8000-0000000000a2', 'Ben TP',   FALSE),
  ('aaaaaaa3-0000-4000-8000-0000000000a3', 'Carla TP', TRUE);

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa3-0000-4000-8000-000000000001', 'Törn TP', '2026-06-01', '2026-06-05',
   'aaaaaaa3-0000-4000-8000-0000000000a1');

INSERT INTO trip_members (trip_id, person_id) VALUES
  ('aaaaaaa3-0000-4000-8000-000000000001', 'aaaaaaa3-0000-4000-8000-0000000000a1'),
  ('aaaaaaa3-0000-4000-8000-000000000001', 'aaaaaaa3-0000-4000-8000-0000000000a2'),
  ('aaaaaaa3-0000-4000-8000-000000000001', 'aaaaaaa3-0000-4000-8000-0000000000a3');

INSERT INTO transactions (id, trip_id, type, date, amount, alcohol_amount, paid_by, split_type) VALUES
  ('aaaaaaa3-0000-4000-8000-000000000010', 'aaaaaaa3-0000-4000-8000-000000000001',
   'expense', '2026-06-02', 60, 12, 'aaaaaaa3-0000-4000-8000-0000000000a1', 'per_person');

INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
  ('aaaaaaa3-0000-4000-8000-000000000010', 'aaaaaaa3-0000-4000-8000-0000000000a1', 20),
  ('aaaaaaa3-0000-4000-8000-000000000010', 'aaaaaaa3-0000-4000-8000-0000000000a2', 30),
  ('aaaaaaa3-0000-4000-8000-000000000010', 'aaaaaaa3-0000-4000-8000-0000000000a3', 10);

SELECT is(
  (SELECT ROUND(SUM(share), 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa3-0000-4000-8000-000000000010'),
  60.00::numeric, 'Pro Person + Alkohol: Σ = Betrag (Alkohol NICHT doppelt verteilt)');

SELECT is(
  (SELECT ROUND(share, 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa3-0000-4000-8000-000000000010'
     AND person_id = 'aaaaaaa3-0000-4000-8000-0000000000a1'),
  20.00::numeric, 'Pro Person: jeder zahlt exakt seinen Einzelbetrag');

-- ════════════════════════════════════════════════════════════════════════
-- TT — Zeitanteilig: A,B je 5 Tage, D 2 Tage → 12 Personentage
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name) VALUES
  ('aaaaaaa4-0000-4000-8000-0000000000a1', 'Anna TT'),
  ('aaaaaaa4-0000-4000-8000-0000000000a2', 'Ben TT'),
  ('aaaaaaa4-0000-4000-8000-0000000000a4', 'Diana TT');

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa4-0000-4000-8000-000000000001', 'Törn TT', '2026-06-01', '2026-06-05',
   'aaaaaaa4-0000-4000-8000-0000000000a1');

INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to) VALUES
  ('aaaaaaa4-0000-4000-8000-000000000001', 'aaaaaaa4-0000-4000-8000-0000000000a1', NULL, NULL),
  ('aaaaaaa4-0000-4000-8000-000000000001', 'aaaaaaa4-0000-4000-8000-0000000000a2', NULL, NULL),
  ('aaaaaaa4-0000-4000-8000-000000000001', 'aaaaaaa4-0000-4000-8000-0000000000a4', '2026-06-04', '2026-06-05');

INSERT INTO transactions (id, trip_id, type, date, amount, paid_by, split_type) VALUES
  ('aaaaaaa4-0000-4000-8000-000000000010', 'aaaaaaa4-0000-4000-8000-000000000001',
   'expense', '2026-06-02', 120, 'aaaaaaa4-0000-4000-8000-0000000000a1', 'time_proportional');

SELECT is(
  (SELECT ROUND(SUM(share), 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa4-0000-4000-8000-000000000010'),
  120.00::numeric, 'Zeitanteilig: Σ = Betrag');

SELECT is(
  (SELECT ROUND(share, 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa4-0000-4000-8000-000000000010'
     AND person_id = 'aaaaaaa4-0000-4000-8000-0000000000a1'),
  50.00::numeric, 'Zeitanteilig: 5 von 12 Tagen → 120 × 5/12 = 50€');

SELECT is(
  (SELECT ROUND(share, 2) FROM v_transaction_shares
   WHERE transaction_id = 'aaaaaaa4-0000-4000-8000-000000000010'
     AND person_id = 'aaaaaaa4-0000-4000-8000-0000000000a4'),
  20.00::numeric, 'Zeitanteilig: 2 von 12 Tagen → 120 × 2/12 = 20€');

-- ════════════════════════════════════════════════════════════════════════
-- TA — Gutschrift "An Alle" bei N=2: ein Empfänger, Saldo-Summe 0
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name) VALUES
  ('aaaaaaa5-0000-4000-8000-0000000000a1', 'Anna TA'),
  ('aaaaaaa5-0000-4000-8000-0000000000a2', 'Ben TA');

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa5-0000-4000-8000-000000000001', 'Törn TA', '2026-06-01', '2026-06-05',
   'aaaaaaa5-0000-4000-8000-0000000000a1');

INSERT INTO trip_members (trip_id, person_id) VALUES
  ('aaaaaaa5-0000-4000-8000-000000000001', 'aaaaaaa5-0000-4000-8000-0000000000a1'),
  ('aaaaaaa5-0000-4000-8000-000000000001', 'aaaaaaa5-0000-4000-8000-0000000000a2');

INSERT INTO transactions (id, trip_id, type, date, amount, credit_from, credit_to) VALUES
  ('aaaaaaa5-0000-4000-8000-000000000010', 'aaaaaaa5-0000-4000-8000-000000000001',
   'credit', '2026-06-01', 240, 'aaaaaaa5-0000-4000-8000-0000000000a1', NULL);

SELECT is(
  (SELECT ROUND(balance, 2) FROM v_balances
   WHERE trip_id = 'aaaaaaa5-0000-4000-8000-000000000001'
     AND person_id = 'aaaaaaa5-0000-4000-8000-0000000000a1'),
  240.00::numeric, 'An Alle N=2: Geber-Saldo +240€');

SELECT is(
  (SELECT ROUND(balance, 2) FROM v_balances
   WHERE trip_id = 'aaaaaaa5-0000-4000-8000-000000000001'
     AND person_id = 'aaaaaaa5-0000-4000-8000-0000000000a2'),
  -240.00::numeric, 'An Alle N=2: einziger Empfänger −240€');

SELECT is(
  (SELECT ROUND(SUM(balance), 2) FROM v_balances
   WHERE trip_id = 'aaaaaaa5-0000-4000-8000-000000000001'),
  0.00::numeric, 'An Alle N=2: Saldo-Summe bleibt 0');

-- ════════════════════════════════════════════════════════════════════════
-- TPP — v_prepayment_payments: tranche-getaggte Gutschrift zählt als Eingang
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO persons (id, display_name) VALUES
  ('aaaaaaa6-0000-4000-8000-0000000000a1', 'Anna TPP'),
  ('aaaaaaa6-0000-4000-8000-0000000000a2', 'Ben TPP');

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('aaaaaaa6-0000-4000-8000-000000000001', 'Törn TPP', '2026-07-01', '2026-07-07',
   'aaaaaaa6-0000-4000-8000-0000000000a1');

INSERT INTO prepayment_tranches (id, trip_id, due_date, label, percent) VALUES
  ('aaaaaaa6-0000-4000-8000-000000000020', 'aaaaaaa6-0000-4000-8000-000000000001',
   '2026-06-01', 'Endzahlung', 100);

INSERT INTO transactions (id, trip_id, type, date, amount, credit_from, credit_to, tranche_id) VALUES
  ('aaaaaaa6-0000-4000-8000-000000000010', 'aaaaaaa6-0000-4000-8000-000000000001',
   'credit', '2026-05-20', 180, 'aaaaaaa6-0000-4000-8000-0000000000a2', NULL,
   'aaaaaaa6-0000-4000-8000-000000000020');

SELECT is(
  (SELECT ROUND(paid_amount, 2) FROM v_prepayment_payments
   WHERE tranche_id = 'aaaaaaa6-0000-4000-8000-000000000020'
     AND person_id = 'aaaaaaa6-0000-4000-8000-0000000000a2'),
  180.00::numeric, 'Anzahlungs-Pool: tranche-getaggte Gutschrift = 180€ Eingang');

SELECT * FROM finish();
ROLLBACK;
