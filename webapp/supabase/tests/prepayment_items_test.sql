-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0058: Reise-Posten (prepayment_items) als dritter Topf
--
-- Geprüft:
--   A. Integrität: Composite-FKs (Kategorie/Soll/Buchung nur im eigenen
--      Törn), total_amount > 0, CHECK „nie Tranche UND Posten",
--      tx_credit_self (Posten-Selbstverrechnung erlaubt, Bordkasse-A→A
--      weiterhin verboten, Zurückholen einer soft-gelöschten A→A-Zeile
--      verboten).
--   B. Bilanz: Szenario Vorstrecker-Ausgabe mit item_id + Crew-Gutschriften
--      mit item_id + Selbstverrechnung + Pending-Selbstmeldung + eine
--      normale Bordkasse-Ausgabe:
--        • Σ v_balances = 0 (Gesamtbilanz bleibt geschlossen)
--        • Pending zählt nirgends
--        • v_balances_bordkasse_only enthält NUR die Bordkasse-Ausgabe
--        • simplify_debts liefert nur die Bordkasse-Überweisungen
--        • sobald alle gezahlt haben, ist der Posten-Topf je Person 0
--          (Gesamtbilanz = Bordkasse-Bilanz)
--        • v_prepayment_item_payments / _pending mit confirmed_at-Filter
--   C. Lösch-Schutz (Fund B4): bestätigte Gutschrift / Anbieter-Ausgabe /
--      Pending blocken; soft-gelöschte (auch Selbst-)Verrechnungen werden
--      entkoppelt; der Törn als Ganzes bleibt löschbar.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(30);

-- ── Setup ─────────────────────────────────────────────────────────────
INSERT INTO persons(id, display_name) VALUES
  ('58580000-0000-4000-8000-000000000001', 'Item Vorstrecker'),
  ('58580000-0000-4000-8000-000000000002', 'Item Crew A'),
  ('58580000-0000-4000-8000-000000000003', 'Item Crew B'),
  ('58580000-0000-4000-8000-000000000004', 'Item Fremd');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('58580000-0000-4000-8000-0000000000aa', 'pgTAP Posten', '2027-05-01', '2027-05-10',
   '58580000-0000-4000-8000-000000000001'),
  ('58580000-0000-4000-8000-0000000000bb', 'pgTAP Posten Fremdtörn', '2027-06-01', '2027-06-10',
   '58580000-0000-4000-8000-000000000004');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000001'),
  ('58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000002'),
  ('58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000003'),
  ('58580000-0000-4000-8000-0000000000bb', '58580000-0000-4000-8000-000000000004');

INSERT INTO trip_categories(id, trip_id, name) VALUES
  ('58580000-0000-4000-8000-0000000000c1', '58580000-0000-4000-8000-0000000000aa', 'An-/Abreise'),
  ('58580000-0000-4000-8000-0000000000c2', '58580000-0000-4000-8000-0000000000bb', 'An-/Abreise');

INSERT INTO prepayment_items(id, trip_id, category_id, label, total_amount, due_date, payee_person_id, split_type) VALUES
  ('58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000aa',
   '58580000-0000-4000-8000-0000000000c1', 'Flüge', 300, '2027-03-01',
   '58580000-0000-4000-8000-000000000001', 'gleichmaessig');

INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount) VALUES
  ('58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000001', 100),
  ('58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000002', 100),
  ('58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000003', 100);

INSERT INTO prepayment_tranches(id, trip_id, due_date, label, percent) VALUES
  ('58580000-0000-4000-8000-0000000000e9', '58580000-0000-4000-8000-0000000000aa', '2027-02-01', 'Endzahlung', 100);

-- ── A. Integrität ─────────────────────────────────────────────────────
SELECT throws_ok(
  $$INSERT INTO prepayment_items(trip_id, category_id, label, total_amount, payee_person_id, split_type)
    VALUES ('58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-0000000000c2',
            'Bahn', 50, '58580000-0000-4000-8000-000000000001', 'gleichmaessig')$$,
  '23503', NULL, 'A1: Kategorie eines FREMDEN Törns wird abgewiesen (Composite-FK)');

SELECT throws_ok(
  $$INSERT INTO prepayment_items(trip_id, label, total_amount, payee_person_id, split_type)
    VALUES ('58580000-0000-4000-8000-0000000000aa', 'Bahn', 0,
            '58580000-0000-4000-8000-000000000001', 'gleichmaessig')$$,
  '23514', NULL, 'A2: Posten mit Summe 0 wird abgewiesen');

SELECT throws_ok(
  $$INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount)
    VALUES ('58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000bb',
            '58580000-0000-4000-8000-000000000004', 10)$$,
  '23503', NULL, 'A3: Soll mit trip_id eines fremden Törns wird abgewiesen (Composite-FK)');

SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id)
    VALUES ('58580000-0000-4000-8000-0000000000bb', 'credit', '2027-06-02', 10,
            '58580000-0000-4000-8000-000000000004', '58580000-0000-4000-8000-000000000001',
            '58580000-0000-4000-8000-0000000000d1')$$,
  '23503', NULL, 'A4: Buchung eines fremden Törns kann keinem Posten dieses Törns zugeordnet werden');

SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, tranche_id, item_id)
    VALUES ('58580000-0000-4000-8000-0000000000aa', 'credit', '2027-02-01', 10,
            '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000001',
            '58580000-0000-4000-8000-0000000000e9', '58580000-0000-4000-8000-0000000000d1')$$,
  '23514', NULL, 'A5: Buchung mit Tranche UND Posten verletzt tx_pool_exclusive');

SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to)
    VALUES ('58580000-0000-4000-8000-0000000000aa', 'credit', '2027-05-02', 10,
            '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000002')$$,
  '23514', NULL, 'A6: Bordkasse-Selbstgutschrift A→A bleibt verboten (Lockerung nur für Töpfe)');

-- Selbstverrechnung des Vorstreckers auf den Posten (sein eigener Anteil).
SELECT lives_ok(
  $$INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id)
    VALUES ('58580000-0000-4000-8000-000000000103', '58580000-0000-4000-8000-0000000000aa',
            'credit', '2027-03-01', 100,
            '58580000-0000-4000-8000-000000000001', '58580000-0000-4000-8000-000000000001',
            '58580000-0000-4000-8000-0000000000d1')$$,
  'A7: Selbstverrechnung mit item_id ist erlaubt');

-- Soft-gelöschte A→A-Zeile darf existieren, aber nicht zurückgeholt werden.
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, deleted_at)
VALUES ('58580000-0000-4000-8000-000000000199', '58580000-0000-4000-8000-0000000000aa',
        'credit', '2027-05-02', 10,
        '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000002', now());
SELECT throws_ok(
  $$UPDATE transactions SET deleted_at = NULL
     WHERE id = '58580000-0000-4000-8000-000000000199'$$,
  '23514', NULL, 'A8: soft-gelöschte A→A-Zeile ohne Topf kann nicht zurückgeholt werden');

-- ── B. Bilanz-Szenario ────────────────────────────────────────────────
-- Vorstrecker zahlt 300 € Flüge an die Airline (Ausgabe mit item_id).
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type, item_id) VALUES
  ('58580000-0000-4000-8000-000000000101', '58580000-0000-4000-8000-0000000000aa',
   'expense', '2027-03-01', 'Flüge', 300,
   '58580000-0000-4000-8000-000000000001', 'equal', '58580000-0000-4000-8000-0000000000d1');
-- Crew A zahlt ihm ihren Anteil (bestätigt).
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id) VALUES
  ('58580000-0000-4000-8000-000000000102', '58580000-0000-4000-8000-0000000000aa',
   'credit', '2027-03-05', 100,
   '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d1');
-- Crew B meldet nur selbst (pending) — und bewusst nur eine TEILzahlung:
-- bei voller Zahlung wäre der Posten-Topf auch in der Bordkasse-View
-- zufällig 0, und ein fehlender item_id-Filter bliebe unentdeckt
-- (mutationsgetestet).
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id, confirmed_at) VALUES
  ('58580000-0000-4000-8000-000000000104', '58580000-0000-4000-8000-0000000000aa',
   'credit', '2027-03-06', 50,
   '58580000-0000-4000-8000-000000000003', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d1', NULL);
-- Normale Bordkasse-Ausgabe: A kauft für 60 € ein.
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('58580000-0000-4000-8000-000000000105', '58580000-0000-4000-8000-0000000000aa',
   'expense', '2027-05-02', 'Lebensmittel', 60,
   '58580000-0000-4000-8000-000000000002', 'equal');

SELECT is(
  (SELECT SUM(balance) FROM v_balances WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'),
  0::numeric, 'B1: Σ v_balances = 0 mit Posten-Ausgabe, -Gutschrift, Selbstverrechnung und Pending');

-- V: 300 bezahlt + 100 gegeben − 120 Anteil − 200 empfangen = +80
SELECT is(
  (SELECT balance FROM v_balances WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'
     AND person_id = '58580000-0000-4000-8000-000000000001'),
  80::numeric, 'B2: Vorstrecker-Gesamtsaldo +80 (Selbstverrechnung neutral)');

-- B: nur Anteile (100 Posten + 20 Bordkasse), Pending zählt nicht → −120
SELECT is(
  (SELECT balance FROM v_balances WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'
     AND person_id = '58580000-0000-4000-8000-000000000003'),
  -120::numeric, 'B3: Pending-Selbstmeldung zählt nicht in v_balances');

-- Bordkasse-Bilanz kennt NUR die 60-€-Ausgabe: V −20, A +40, B −20.
SELECT is(
  (SELECT balance FROM v_balances_bordkasse_only WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'
     AND person_id = '58580000-0000-4000-8000-000000000001'),
  -20::numeric, 'B4: v_balances_bordkasse_only ignoriert Posten-Buchungen (Vorstrecker −20)');

SELECT is(
  (SELECT balance FROM v_balances_bordkasse_only WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'
     AND person_id = '58580000-0000-4000-8000-000000000002'),
  40::numeric, 'B5: v_balances_bordkasse_only — Crew A +40 (nur Bordkasse-Einkauf)');

SELECT is(
  (SELECT SUM(balance) FROM v_balances_bordkasse_only WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'),
  0::numeric, 'B6: Σ v_balances_bordkasse_only = 0');

SELECT is(
  (SELECT count(*)::int || '/' || SUM(amount)::text
     FROM simplify_debts('58580000-0000-4000-8000-0000000000aa')),
  '2/40.00', 'B7: simplify_debts liefert nur die Bordkasse-Überweisungen (2 × 20 €)');

SELECT is(
  (SELECT SUM(paid_amount) FROM v_prepayment_item_payments
    WHERE item_id = '58580000-0000-4000-8000-0000000000d1'),
  200::numeric, 'B8: v_prepayment_item_payments zählt bestätigte Gutschriften (A + Selbstverrechnung)');

SELECT is(
  (SELECT count(*) FROM v_prepayment_item_payments
    WHERE item_id = '58580000-0000-4000-8000-0000000000d1'
      AND person_id = '58580000-0000-4000-8000-000000000003'),
  0::bigint, 'B9: Pending-Selbstmeldung erscheint NICHT in v_prepayment_item_payments');

SELECT is(
  (SELECT transaction_id FROM v_prepayment_item_pending
    WHERE item_id = '58580000-0000-4000-8000-0000000000d1'),
  '58580000-0000-4000-8000-000000000104'::uuid, 'B10: v_prepayment_item_pending listet die offene Selbstmeldung');

-- Vorstrecker bestätigt B, B überweist den Rest → alle haben gezahlt.
UPDATE transactions SET confirmed_at = now() WHERE id = '58580000-0000-4000-8000-000000000104';
INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id) VALUES
  ('58580000-0000-4000-8000-0000000000aa', 'credit', '2027-03-08', 50,
   '58580000-0000-4000-8000-000000000003', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d1');

SELECT is(
  (SELECT count(*) FROM v_balances g
     JOIN v_balances_bordkasse_only b ON b.trip_id = g.trip_id AND b.person_id = g.person_id
    WHERE g.trip_id = '58580000-0000-4000-8000-0000000000aa'
      AND g.balance = b.balance),
  3::bigint, 'B11: alle gezahlt → Posten-Topf je Person 0 (Gesamtbilanz = Bordkasse-Bilanz)');

SELECT is(
  (SELECT SUM(balance) FROM v_balances WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'),
  0::numeric, 'B12: Σ v_balances = 0 auch nach Bestätigung');

-- ── C. Lösch-Schutz (Fund B4) ─────────────────────────────────────────
INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type) VALUES
  ('58580000-0000-4000-8000-0000000000d2', '58580000-0000-4000-8000-0000000000aa', 'Bahn hin',  90, '58580000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('58580000-0000-4000-8000-0000000000d3', '58580000-0000-4000-8000-0000000000aa', 'Bahn rück', 90, '58580000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('58580000-0000-4000-8000-0000000000d4', '58580000-0000-4000-8000-0000000000aa', 'Fähre',     30, '58580000-0000-4000-8000-000000000001', 'individuell'),
  ('58580000-0000-4000-8000-0000000000d5', '58580000-0000-4000-8000-0000000000aa', 'Taxi',      45, '58580000-0000-4000-8000-000000000001', 'gleichmaessig');

INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount) VALUES
  ('58580000-0000-4000-8000-0000000000d5', '58580000-0000-4000-8000-0000000000aa', '58580000-0000-4000-8000-000000000002', 15);

-- d2: nur eine bestätigte Anbieter-Ausgabe (expense, confirmed_at DEFAULT now()).
INSERT INTO transactions(trip_id, type, date, amount, paid_by, split_type, item_id) VALUES
  ('58580000-0000-4000-8000-0000000000aa', 'expense', '2027-04-01', 90,
   '58580000-0000-4000-8000-000000000001', 'equal', '58580000-0000-4000-8000-0000000000d2');
-- d3: nur eine bestätigte Selbstverrechnung.
INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id) VALUES
  ('58580000-0000-4000-8000-0000000000aa', 'credit', '2027-04-01', 30,
   '58580000-0000-4000-8000-000000000001', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d3');
-- d4: nur eine offene Selbstmeldung (pending) — und eine soft-gelöschte.
INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id, confirmed_at) VALUES
  ('58580000-0000-4000-8000-0000000000aa', 'credit', '2027-04-01', 10,
   '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d4', NULL);
-- d5: nur soft-gelöschte Zeilen — eine Selbstverrechnung (würde ohne die
-- deleted_at-Ausnahme im Check beim SET NULL mit 23514 scheitern) und eine
-- abgelehnte Selbstmeldung (Reject = Soft-Delete, confirmed_at NULL).
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id, deleted_at) VALUES
  ('58580000-0000-4000-8000-000000000151', '58580000-0000-4000-8000-0000000000aa', 'credit', '2027-04-01', 15,
   '58580000-0000-4000-8000-000000000001', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d5', now());
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id, deleted_at, confirmed_at) VALUES
  ('58580000-0000-4000-8000-000000000152', '58580000-0000-4000-8000-0000000000aa', 'credit', '2027-04-01', 15,
   '58580000-0000-4000-8000-000000000002', '58580000-0000-4000-8000-000000000001',
   '58580000-0000-4000-8000-0000000000d5', now(), NULL);

SELECT throws_ok(
  $$DELETE FROM prepayment_items WHERE id = '58580000-0000-4000-8000-0000000000d1'$$,
  'P0001', 'prepayment_item_has_payments',
  'C1: Posten mit bestätigten Crew-Gutschriften ist nicht löschbar');

SELECT throws_ok(
  $$DELETE FROM prepayment_items WHERE id = '58580000-0000-4000-8000-0000000000d2'$$,
  'P0001', 'prepayment_item_has_payments',
  'C2: Posten mit bestätigter Anbieter-Ausgabe ist nicht löschbar');

SELECT throws_ok(
  $$DELETE FROM prepayment_items WHERE id = '58580000-0000-4000-8000-0000000000d3'$$,
  'P0001', 'prepayment_item_has_payments',
  'C3: Posten mit bestätigter Selbstverrechnung ist nicht löschbar (statt 23514)');

SELECT throws_ok(
  $$DELETE FROM prepayment_items WHERE id = '58580000-0000-4000-8000-0000000000d4'$$,
  'P0001', 'prepayment_item_has_pending',
  'C4: Posten mit offener Selbstmeldung ist nicht löschbar (kippte sonst als Pending in die Bordkasse)');

SELECT lives_ok(
  $$DELETE FROM prepayment_items WHERE id = '58580000-0000-4000-8000-0000000000d5'$$,
  'C5: Posten mit nur soft-gelöschten Zeilen (inkl. Selbstverrechnung) ist löschbar');

SELECT is(
  (SELECT count(*) FROM transactions
    WHERE id IN ('58580000-0000-4000-8000-000000000151', '58580000-0000-4000-8000-000000000152')
      AND item_id IS NULL AND deleted_at IS NOT NULL),
  2::bigint, 'C6: soft-gelöschte Zeilen überleben, nur die Posten-Zuordnung ist entkoppelt');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations
    WHERE item_id = '58580000-0000-4000-8000-0000000000d5'),
  0::bigint, 'C7: Soll des gelöschten Postens ist per CASCADE weg');

SELECT is(
  (SELECT count(*) FROM prepayment_items WHERE id IN (
     '58580000-0000-4000-8000-0000000000d1', '58580000-0000-4000-8000-0000000000d2',
     '58580000-0000-4000-8000-0000000000d3', '58580000-0000-4000-8000-0000000000d4')),
  4::bigint, 'C8: blockierte Posten existieren unverändert weiter');

-- Der ganze Törn bleibt löschbar (deleteTrip → CASCADE), auch mit Posten,
-- bestätigten Zahlungen und einer Selbstverrechnung.
SELECT lives_ok(
  $$DELETE FROM trips WHERE id = '58580000-0000-4000-8000-0000000000aa'$$,
  'C9: Törn mit Posten + Zahlungen + Selbstverrechnung ist per CASCADE löschbar');

SELECT is(
  (SELECT count(*) FROM prepayment_items WHERE trip_id = '58580000-0000-4000-8000-0000000000aa'),
  0::bigint, 'C10: Posten sind mit dem Törn verschwunden');

SELECT * FROM finish();
ROLLBACK;
