-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0058: DSGVO-Pfade kennen die Reise-Posten.
--
-- Muster wie purge_with_tranche_self_credit_test.sql (Bug 0048): ein Törn,
-- in dem der Posten-Empfänger seinen EIGENEN Anteil als Selbstverrechnung
-- gebucht hat (`credit_from = credit_to`, erlaubt nur mit `item_id`), muss
-- purgebar sein. Zusätzlich hängen am Posten eine bestätigte Crew-Gutschrift
-- und eine offene Selbstmeldung — genau die Zeilen, die der Lösch-Schutz-
-- Trigger auf prepayment_items blocken würde, wenn der Purge sie nicht VOR
-- dem Löschen entkoppelt.
--
-- Geprüft:
--   1. purge_trip_data (force=FALSE, wie der Cron) läuft durch, löscht
--      Posten + Posten-Soll, entkoppelt alle Buchungen, erhält die Beträge.
--   2. Orphan-Cleanup lässt eine Ex-Person stehen, die in einem ANDEREN Törn
--      noch Posten-Empfänger ist (FK RESTRICT → sonst Abbruch des ganzen
--      Purge) bzw. dort noch ein Posten-Soll hat (FK CASCADE → sonst stiller
--      Soll-Verlust).
--   3. admin_delete_person_data löscht das Posten-Soll der Person, lässt den
--      Posten (Empfänger = anonymisierte Person) und dessen Selbstverrechnung
--      stehen.
--   4. delete_my_account (Altpfad) ebenso.
--   5. Beide Konto-Löschungen blocken einen Posten-Empfänger in einem
--      LAUFENDEN Törn (`is_active_item_payee`, Review-Fund M1), auch ohne
--      jede Buchung; nach Törnende nicht mehr — dann bleibt der Empfänger
--      aber (anonymisiert) Crew, damit späte Rückzahlungen Σ = 0 halten.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(20);

-- ── Setup Törn P (abgelaufen, abgerechnet) ────────────────────────────
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('58590000-0000-4000-8000-000000000001', 'Purge Item Vorstrecker', NULL),
  ('58590000-0000-4000-8000-000000000002', 'Purge Item Crew', NULL),
  -- G: Ex-Person, nirgends Crew, aber Posten-Empfänger in Törn Q
  ('58590000-0000-4000-8000-000000000007', 'Purge Item Ghost-Empfänger', NULL),
  -- H: Ex-Person, nirgends Crew, aber Posten-Soll in Törn Q
  ('58590000-0000-4000-8000-000000000008', 'Purge Item Ghost-Soll', NULL);

INSERT INTO trips(id, name, start_date, end_date, skipper_id, settlement_announced_at) VALUES
  ('58590000-0000-4000-8000-0000000000aa', 'pgTAP Purge Posten', '2020-04-01', '2020-04-10',
   '58590000-0000-4000-8000-000000000001', now()),
  ('58590000-0000-4000-8000-0000000000bb', 'pgTAP Purge Posten (anderer Törn)', '2099-04-01', '2099-04-10',
   NULL, NULL);

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('58590000-0000-4000-8000-0000000000aa', '58590000-0000-4000-8000-000000000001'),
  ('58590000-0000-4000-8000-0000000000aa', '58590000-0000-4000-8000-000000000002');

INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type) VALUES
  ('58590000-0000-4000-8000-0000000000d1', '58590000-0000-4000-8000-0000000000aa',
   'Flüge', 200, '58590000-0000-4000-8000-000000000001', 'gleichmaessig'),
  ('58590000-0000-4000-8000-0000000000d9', '58590000-0000-4000-8000-0000000000bb',
   'Bahn', 80, '58590000-0000-4000-8000-000000000007', 'individuell');

INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount) VALUES
  ('58590000-0000-4000-8000-0000000000d1', '58590000-0000-4000-8000-0000000000aa', '58590000-0000-4000-8000-000000000001', 100),
  ('58590000-0000-4000-8000-0000000000d1', '58590000-0000-4000-8000-0000000000aa', '58590000-0000-4000-8000-000000000002', 100),
  ('58590000-0000-4000-8000-0000000000d9', '58590000-0000-4000-8000-0000000000bb', '58590000-0000-4000-8000-000000000008', 80);

-- Anbieter-Zahlung (Ausgabe), Crew-Gutschrift, Selbstverrechnung, offene
-- Selbstmeldung, soft-gelöschte Selbstverrechnung.
INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type, item_id, created_by) VALUES
  ('58590000-0000-4000-8000-000000000101', '58590000-0000-4000-8000-0000000000aa', 'expense', '2020-02-01',
   'Flüge', 200, '58590000-0000-4000-8000-000000000001', 'equal',
   '58590000-0000-4000-8000-0000000000d1', '58590000-0000-4000-8000-000000000001');
INSERT INTO transactions(id, trip_id, type, date, description, amount, credit_from, credit_to, item_id, confirmed_at) VALUES
  ('58590000-0000-4000-8000-000000000102', '58590000-0000-4000-8000-0000000000aa', 'credit', '2020-02-02',
   'Flug Crew', 100, '58590000-0000-4000-8000-000000000002', '58590000-0000-4000-8000-000000000001',
   '58590000-0000-4000-8000-0000000000d1', now()),
  ('58590000-0000-4000-8000-000000000103', '58590000-0000-4000-8000-0000000000aa', 'credit', '2020-02-02',
   'Eigener Anteil', 100, '58590000-0000-4000-8000-000000000001', '58590000-0000-4000-8000-000000000001',
   '58590000-0000-4000-8000-0000000000d1', now()),
  ('58590000-0000-4000-8000-000000000104', '58590000-0000-4000-8000-0000000000aa', 'credit', '2020-02-03',
   'Doppelt gemeldet', 50, '58590000-0000-4000-8000-000000000002', '58590000-0000-4000-8000-000000000001',
   '58590000-0000-4000-8000-0000000000d1', NULL);
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id, deleted_at) VALUES
  ('58590000-0000-4000-8000-000000000105', '58590000-0000-4000-8000-0000000000aa', 'credit', '2020-02-04',
   100, '58590000-0000-4000-8000-000000000001', '58590000-0000-4000-8000-000000000001',
   '58590000-0000-4000-8000-0000000000d1', now());

-- ── 1. Purge (force=FALSE, wie der nächtliche Cron) ────────────────────
SELECT lives_ok(
  $$ SELECT purge_trip_data('58590000-0000-4000-8000-0000000000aa', FALSE) $$,
  'Purge eines Törns mit Posten-Selbstverrechnung wirft nicht (Trigger/tx_credit_self/FK)');

SELECT is(
  (SELECT retention_purged_at IS NOT NULL FROM trips WHERE id = '58590000-0000-4000-8000-0000000000aa'),
  TRUE, 'Purge lief vollständig durch');

SELECT is(
  (SELECT count(*) FROM prepayment_items WHERE trip_id = '58590000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Posten (mit payee_person_id) sind gelöscht');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations WHERE trip_id = '58590000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Posten-Soll (personenbezogen!) ist gelöscht');

SELECT is(
  (SELECT count(*) FROM transactions
    WHERE trip_id = '58590000-0000-4000-8000-0000000000aa'
      AND (item_id IS NOT NULL OR credit_from IS NOT NULL OR credit_to IS NOT NULL OR paid_by IS NOT NULL)),
  0::bigint, 'Alle Buchungen sind entkoppelt und ohne Personenbezug');

SELECT is(
  (SELECT amount FROM transactions WHERE id = '58590000-0000-4000-8000-000000000103'),
  100::numeric, 'Selbstverrechnung überlebt als anonymisierte Buchung (Betrag erhalten)');

-- ── 2. Orphan-Cleanup respektiert Posten anderer Törns ────────────────
SELECT ok(
  EXISTS (SELECT 1 FROM persons WHERE id = '58590000-0000-4000-8000-000000000007'),
  'Ex-Person, die in einem anderen Törn Posten-Empfänger ist, wird NICHT gelöscht');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations
    WHERE person_id = '58590000-0000-4000-8000-000000000008'),
  1::bigint, 'Posten-Soll einer Ex-Person in einem anderen Törn bleibt erhalten');

-- ── 3. admin_delete_person_data ───────────────────────────────────────
INSERT INTO auth.users(id) VALUES
  ('58590000-0000-4000-8000-0000000000f3'),
  ('58590000-0000-4000-8000-0000000000f4');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('58590000-0000-4000-8000-000000000003', 'Löschen Empfänger', '58590000-0000-4000-8000-0000000000f3'),
  ('58590000-0000-4000-8000-000000000004', 'Löschen Altpfad',   '58590000-0000-4000-8000-0000000000f4');
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('58590000-0000-4000-8000-0000000000cc', 'pgTAP Konto löschen Posten', '2020-05-01', '2020-05-10',
   '58590000-0000-4000-8000-000000000003');
INSERT INTO trip_members(trip_id, person_id) VALUES
  ('58590000-0000-4000-8000-0000000000cc', '58590000-0000-4000-8000-000000000003'),
  ('58590000-0000-4000-8000-0000000000cc', '58590000-0000-4000-8000-000000000004');
INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type) VALUES
  ('58590000-0000-4000-8000-0000000000d3', '58590000-0000-4000-8000-0000000000cc',
   'Flüge', 120, '58590000-0000-4000-8000-000000000003', 'gleichmaessig');
INSERT INTO prepayment_item_obligations(item_id, trip_id, person_id, amount) VALUES
  ('58590000-0000-4000-8000-0000000000d3', '58590000-0000-4000-8000-0000000000cc', '58590000-0000-4000-8000-000000000003', 60),
  ('58590000-0000-4000-8000-0000000000d3', '58590000-0000-4000-8000-0000000000cc', '58590000-0000-4000-8000-000000000004', 60);
INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, item_id) VALUES
  ('58590000-0000-4000-8000-000000000301', '58590000-0000-4000-8000-0000000000cc', 'credit', '2020-04-01',
   60, '58590000-0000-4000-8000-000000000003', '58590000-0000-4000-8000-000000000003',
   '58590000-0000-4000-8000-0000000000d3');

SELECT is(
  admin_delete_person_data('58590000-0000-4000-8000-000000000003'),
  'ok', 'admin_delete_person_data läuft für einen Posten-Empfänger mit Selbstverrechnung durch');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations WHERE person_id = '58590000-0000-4000-8000-000000000003'),
  0::bigint, 'admin_delete_person_data löscht das Posten-Soll der Person');

SELECT ok(
  (SELECT count(*) = 1 FROM prepayment_items
    WHERE id = '58590000-0000-4000-8000-0000000000d3'
      AND payee_person_id = '58590000-0000-4000-8000-000000000003')
  AND (SELECT item_id IS NOT NULL FROM transactions WHERE id = '58590000-0000-4000-8000-000000000301'),
  'Posten (Empfänger = anonymisierte Person) und Selbstverrechnung bleiben bestehen');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations WHERE person_id = '58590000-0000-4000-8000-000000000004'),
  1::bigint, 'Posten-Soll anderer Personen bleibt unberührt');

-- ── 4. delete_my_account (Altpfad über auth.uid()) ────────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '58590000-0000-4000-8000-0000000000f4')::text, TRUE);

SELECT is(
  delete_my_account(), 'ok', 'delete_my_account läuft für eine Person mit Posten-Soll durch');

SELECT is(
  (SELECT count(*) FROM prepayment_item_obligations WHERE person_id = '58590000-0000-4000-8000-000000000004'),
  0::bigint, 'delete_my_account löscht das Posten-Soll der Person');

-- ── 5. Posten-Empfänger in einem LAUFENDEN Törn (Review-Fund M1) ───────
-- Bewusst OHNE jede Buchung: genau dann greift has_active_bookings nicht.
-- Ohne Blocker würde die Person anonymisiert und aus trip_members entfernt;
-- spätere Gutschriften an sie (credit_to = payee) fielen aus v_balances.
INSERT INTO auth.users(id) VALUES
  ('58590000-0000-4000-8000-0000000000f5'),
  ('58590000-0000-4000-8000-0000000000f6');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('58590000-0000-4000-8000-000000000005', 'Aktiv Empfänger',         '58590000-0000-4000-8000-0000000000f5'),
  ('58590000-0000-4000-8000-000000000006', 'Aktiv Empfänger Altpfad', '58590000-0000-4000-8000-0000000000f6');
INSERT INTO persons_private(person_id, email) VALUES
  ('58590000-0000-4000-8000-000000000005', 'aktiv-empfaenger@example.test');
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('58590000-0000-4000-8000-0000000000dd', 'pgTAP laufender Törn mit Posten', CURRENT_DATE - 2, CURRENT_DATE + 5, NULL);
INSERT INTO trip_members(trip_id, person_id) VALUES
  ('58590000-0000-4000-8000-0000000000dd', '58590000-0000-4000-8000-000000000005'),
  ('58590000-0000-4000-8000-0000000000dd', '58590000-0000-4000-8000-000000000006');
INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type) VALUES
  ('58590000-0000-4000-8000-0000000000e5', '58590000-0000-4000-8000-0000000000dd',
   'Flüge', 100, '58590000-0000-4000-8000-000000000005', 'gleichmaessig'),
  ('58590000-0000-4000-8000-0000000000e6', '58590000-0000-4000-8000-0000000000dd',
   'Bahn', 50, '58590000-0000-4000-8000-000000000006', 'gleichmaessig');

SELECT is(
  admin_delete_person_data('58590000-0000-4000-8000-000000000005'),
  'is_active_item_payee',
  'admin_delete_person_data blockt einen Posten-Empfänger in einem laufenden Törn (ohne Buchungen)');

SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '58590000-0000-4000-8000-0000000000dd'
             AND person_id = '58590000-0000-4000-8000-000000000005')
  AND EXISTS (SELECT 1 FROM persons_private WHERE person_id = '58590000-0000-4000-8000-000000000005')
  AND (SELECT display_name FROM persons WHERE id = '58590000-0000-4000-8000-000000000005') = 'Aktiv Empfänger',
  'Blockierter Empfänger bleibt unverändert (Mitgliedschaft, Kontaktdaten, Name)');

SELECT set_config('request.jwt.claims',
  json_build_object('sub', '58590000-0000-4000-8000-0000000000f6')::text, TRUE);

SELECT is(
  delete_my_account(), 'is_active_item_payee',
  'delete_my_account (Altpfad) blockt einen Posten-Empfänger in einem laufenden Törn');

SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '58590000-0000-4000-8000-0000000000dd'
             AND person_id = '58590000-0000-4000-8000-000000000006'),
  'Blockierter Empfänger (Altpfad) bleibt Crew');

-- Gegenprobe: derselbe Törn abgelaufen → kein Blocker (Abschnitt 3 deckt
-- den Normalfall ab; hier dieselbe Person, nur das Datum ändert sich).
UPDATE trips SET start_date = CURRENT_DATE - 10, end_date = CURRENT_DATE - 1
 WHERE id = '58590000-0000-4000-8000-0000000000dd';
SELECT is(
  admin_delete_person_data('58590000-0000-4000-8000-000000000005'),
  'ok', 'nach Törnende ist der Posten-Empfänger löschbar');

-- … bleibt aber (anonymisiert) Crew des Törns, obwohl er keine Buchung hat:
-- späte Rückzahlungen der Crew an ihn wirken sonst nicht in v_balances.
INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to, item_id) VALUES
  ('58590000-0000-4000-8000-0000000000dd', 'credit', CURRENT_DATE, 50,
   '58590000-0000-4000-8000-000000000006', '58590000-0000-4000-8000-000000000005',
   '58590000-0000-4000-8000-0000000000e5');
SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '58590000-0000-4000-8000-0000000000dd'
             AND person_id = '58590000-0000-4000-8000-000000000005')
  AND (SELECT SUM(balance) FROM v_balances WHERE trip_id = '58590000-0000-4000-8000-0000000000dd') = 0,
  'gelöschter Empfänger bleibt Crew; späte Rückzahlung an ihn hält Σ v_balances = 0');

SELECT * FROM finish();
ROLLBACK;
