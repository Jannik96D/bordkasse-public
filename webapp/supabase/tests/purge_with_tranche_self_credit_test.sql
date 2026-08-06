-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0048: ein Törn mit Anzahlungsplan, in dem
-- die vorstreckende Person ihren EIGENEN Anteil als Selbst-Verrechnung
-- gebucht hat (`credit_from = credit_to`, erlaubt nur solange `tranche_id`
-- gesetzt ist — siehe 0024), muss purgebar sein.
--
-- Vorher: `purge_trip_data` löschte `prepayment_tranches`, bevor es die
-- Personenspalten nullte. Der FK `transactions.tranche_id ON DELETE SET NULL`
-- nullte daraufhin genau das Feld, das die Ausnahme im Check `tx_credit_self`
-- trägt → Constraint-Verletzung → der GESAMTE Purge rollte zurück. In
-- Produktion blieb dadurch ein Törn dauerhaft ungelöscht (manueller Button:
-- „Löschung fehlgeschlagen"; Cron: stiller Skip durch die Fehlerisolierung
-- aus 0042) — die 30-Tage-Löschzusage wurde unbemerkt verfehlt.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(10);

-- ── Setup: Zwei-Personen-Törn mit Anzahlungsplan ──────────────────────
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('48480000-0000-4000-8000-000000000001', 'Tranche Vorstrecker', NULL),
  ('48480000-0000-4000-8000-000000000002', 'Tranche Crew', NULL);

INSERT INTO trips(id, name, start_date, end_date, skipper_id, settlement_announced_at) VALUES
  ('48480000-0000-4000-8000-0000000000aa', 'pgTAP Purge Tranche-Self-Credit',
   '2020-03-01', '2020-03-10',
   '48480000-0000-4000-8000-000000000001', now());

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('48480000-0000-4000-8000-0000000000aa', '48480000-0000-4000-8000-000000000001'),
  ('48480000-0000-4000-8000-0000000000aa', '48480000-0000-4000-8000-000000000002');

INSERT INTO prepayment_plan(trip_id, split_method, total_amount, advancer_person_id) VALUES
  ('48480000-0000-4000-8000-0000000000aa', 'gleichmaessig', 400,
   '48480000-0000-4000-8000-000000000001');

INSERT INTO prepayment_tranches(id, trip_id, due_date, label, percent, sort_order) VALUES
  ('48480000-0000-4000-8000-0000000000b1', '48480000-0000-4000-8000-0000000000aa',
   '2020-02-01', 'Endzahlung', 100, 1);

-- cabin_types + prepayment_obligations werden von 0042 (Q2) mit gelöscht,
-- hatten aber bisher NULL Testabdeckung — genau die Lücke, durch die der
-- Reihenfolge-Bug überhaupt in Produktion kam. Hier mit abgedeckt.
INSERT INTO cabin_types(id, trip_id, label, price_per_person, capacity) VALUES
  ('48480000-0000-4000-8000-0000000000c1', '48480000-0000-4000-8000-0000000000aa',
   'Achterkajüte', 200, 2);

INSERT INTO prepayment_obligations(trip_id, person_id, total_amount, cabin_type_id) VALUES
  ('48480000-0000-4000-8000-0000000000aa', '48480000-0000-4000-8000-000000000002',
   200, '48480000-0000-4000-8000-0000000000c1');

-- Der eigentliche Bug-Trigger: Selbst-Verrechnung des Vorstreckers auf die
-- Tranche. Ohne `tranche_id` würde dieser INSERT schon an `tx_credit_self`
-- scheitern — genau diese Ausnahme killt der Purge, wenn er die Tranche
-- zuerst löscht.
INSERT INTO transactions(
  id, trip_id, type, date, description, amount,
  credit_from, credit_to, credit_to_all, created_by, tranche_id
) VALUES (
  '48480000-0000-4000-8000-0000000000e1', '48480000-0000-4000-8000-0000000000aa',
  'credit', '2020-02-01', 'Eigener Anteil verrechnet', 200,
  '48480000-0000-4000-8000-000000000001', '48480000-0000-4000-8000-000000000001',
  FALSE, '48480000-0000-4000-8000-000000000001',
  '48480000-0000-4000-8000-0000000000b1'
);

SELECT ok(
  EXISTS (SELECT 1 FROM transactions
           WHERE id = '48480000-0000-4000-8000-0000000000e1'
             AND credit_from = credit_to
             AND tranche_id IS NOT NULL),
  'Setup: Selbst-Verrechnung auf eine Tranche existiert'
);

-- ── Purge mit force=FALSE ────────────────────────────────────────────
-- Bewusst NICHT force=TRUE: produktiv scheiterte der NÄCHTLICHE CRON, und der
-- ruft `purge_trip_data(id, FALSE)`. Das Fixture braucht den Override auch
-- nicht — end_date liegt weit vor der 30-Tage-Grenze und
-- settlement_announced_at ist gesetzt.
--
-- `lives_ok` zuerst, damit ein Rückfall nicht die ganze Test-Transaktion
-- abbricht (Constraint-Verletzung) und die folgenden Prüfungen mitreißt,
-- sondern als lesbarer Fehlschlag erscheint.
SELECT lives_ok(
  $$ SELECT purge_trip_data('48480000-0000-4000-8000-0000000000aa', FALSE) $$,
  'Purge wirft keine Constraint-Verletzung (tx_credit_self)'
);

SELECT is(
  (SELECT retention_purged_at IS NOT NULL FROM trips
    WHERE id = '48480000-0000-4000-8000-0000000000aa'),
  TRUE,
  'Purge lief durch, obwohl eine Tranchen-Selbst-Verrechnung existiert'
);

-- Der eigentliche Mechanismus: der FK hat `tranche_id` genullt UND die Zeile
-- hat das überlebt. Ohne diese Prüfung ginge z. B. ein Wechsel auf
-- ON DELETE RESTRICT unbemerkt durch.
SELECT ok(
  (SELECT tranche_id IS NULL FROM transactions
    WHERE id = '48480000-0000-4000-8000-0000000000e1'),
  'tranche_id der Selbst-Verrechnung wurde vom FK genullt — Zeile lebt weiter'
);

-- Personenbezug weg …
SELECT ok(
  (SELECT credit_from IS NULL AND credit_to IS NULL AND created_by IS NULL
     FROM transactions WHERE id = '48480000-0000-4000-8000-0000000000e1'),
  'Personenbezug der Selbst-Verrechnung ist entfernt'
);

-- … Buchungs-Kerndaten bleiben (Regel aus 0044) …
SELECT is(
  (SELECT amount FROM transactions WHERE id = '48480000-0000-4000-8000-0000000000e1'),
  200::numeric,
  'Betrag der Buchung bleibt erhalten'
);

-- … und die Anzahlungs-Tabellen sind leer (DSGVO-Leftover aus 0042).
SELECT is(
  (SELECT count(*) FROM prepayment_tranches
    WHERE trip_id = '48480000-0000-4000-8000-0000000000aa'),
  0::bigint,
  'Anzahlungs-Tranchen sind gelöscht'
);

SELECT is(
  (SELECT count(*) FROM prepayment_obligations
    WHERE trip_id = '48480000-0000-4000-8000-0000000000aa'),
  0::bigint,
  'Anzahlungs-Soll (personenbezogen!) ist gelöscht'
);

SELECT is(
  (SELECT count(*) FROM cabin_types
    WHERE trip_id = '48480000-0000-4000-8000-0000000000aa'),
  0::bigint,
  'Kojen-Typen sind gelöscht'
);

SELECT is(
  (SELECT count(*) FROM prepayment_plan
    WHERE trip_id = '48480000-0000-4000-8000-0000000000aa'),
  0::bigint,
  'Anzahlungsplan ist gelöscht'
);

SELECT * FROM finish();
ROLLBACK;
