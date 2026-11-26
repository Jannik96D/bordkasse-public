-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0063 (Sicherheitsrunde 2026-11, Slice 5):
-- Kontolöschung darf keine Anteile verschieben.
--
-- Geprüft:
--   1. Mitesser (nur „Gleichmäßig"-Anteile, keine eigene Buchung) in einem
--      BEENDETEN Törn löscht sein Konto → bleibt (anonymisiert) Crew,
--      v_balances aller Personen unverändert, Σ = 0.
--      (Alte Function: Mitgliedschaft gelöscht → Anteil wandert auf die Crew.)
--   2. Trinker mit trip_members.is_alcoholic = NULL und persons.is_alcoholic
--      = TRUE löscht → Flag wird in die Mitgliedschaft übernommen, Salden
--      vorher = nachher. (Alt: persons.is_alcoholic = FALSE verschob den
--      Alkoholanteil auf die übrigen Trinker.)
--   3. Mitglied eines laufenden bzw. künftigen Törns → `is_active_member`,
--      nichts wird geändert.
--   4. Beendeter Törn ohne (nicht gelöschte) Buchungen → Mitgliedschaft wird
--      entfernt; auch wenn nur soft-gelöschte Buchungen existieren.
--   5. `delete_my_account()` existiert nicht mehr (Seiteneingang per RPC).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(17);

-- ── Setup ─────────────────────────────────────────────────────────────
INSERT INTO auth.users(id) VALUES
  ('63630000-0000-4000-8000-0000000000f2'),
  ('63630000-0000-4000-8000-0000000000f3'),
  ('63630000-0000-4000-8000-0000000000f5'),
  ('63630000-0000-4000-8000-0000000000f6'),
  ('63630000-0000-4000-8000-0000000000f7'),
  ('63630000-0000-4000-8000-0000000000f8');

INSERT INTO persons(id, display_name, auth_user_id, is_alcoholic) VALUES
  -- P: Zahler, Trinker per Mitgliedschafts-Override
  ('63630000-0000-4000-8000-000000000001', 'KL Zahler',   NULL, FALSE),
  -- M: reiner Mitesser, nie gebucht
  ('63630000-0000-4000-8000-000000000002', 'KL Mitesser', '63630000-0000-4000-8000-0000000000f2', FALSE),
  -- T: Trinker NUR über das Personen-Flag (trip_members.is_alcoholic NULL)
  ('63630000-0000-4000-8000-000000000003', 'KL Trinker',  '63630000-0000-4000-8000-0000000000f3', TRUE),
  -- N: Nicht-Trinker
  ('63630000-0000-4000-8000-000000000004', 'KL Nüchtern', NULL, FALSE),
  -- A: Mitglied eines laufenden Törns, ohne Buchung
  ('63630000-0000-4000-8000-000000000005', 'KL Laufend',  '63630000-0000-4000-8000-0000000000f5', FALSE),
  -- F: Mitglied eines künftigen Törns, ohne Buchung
  ('63630000-0000-4000-8000-000000000006', 'KL Künftig',  '63630000-0000-4000-8000-0000000000f6', FALSE),
  -- B: Mitglied eines beendeten Törns ohne jede Buchung
  ('63630000-0000-4000-8000-000000000007', 'KL Leer',     '63630000-0000-4000-8000-0000000000f7', FALSE),
  -- C: Mitglied eines beendeten Törns mit nur soft-gelöschter Buchung
  ('63630000-0000-4000-8000-000000000008', 'KL Gelöscht', '63630000-0000-4000-8000-0000000000f8', FALSE);

INSERT INTO persons_private(person_id, email) VALUES
  ('63630000-0000-4000-8000-000000000005', 'kl-laufend@example.test');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('63630000-0000-4000-8000-0000000000e1', 'pgTAP KL beendet',      '2020-06-01', '2020-06-10',
   '63630000-0000-4000-8000-000000000001'),
  ('63630000-0000-4000-8000-0000000000e2', 'pgTAP KL laufend',      CURRENT_DATE - 2, CURRENT_DATE + 5,
   '63630000-0000-4000-8000-000000000001'),
  ('63630000-0000-4000-8000-0000000000e3', 'pgTAP KL künftig',      '2099-06-01', '2099-06-10',
   '63630000-0000-4000-8000-000000000001'),
  ('63630000-0000-4000-8000-0000000000e4', 'pgTAP KL leer',         '2020-07-01', '2020-07-10',
   '63630000-0000-4000-8000-000000000001'),
  ('63630000-0000-4000-8000-0000000000e5', 'pgTAP KL nur gelöscht', '2020-08-01', '2020-08-10',
   '63630000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id, is_alcoholic) VALUES
  ('63630000-0000-4000-8000-0000000000e1', '63630000-0000-4000-8000-000000000001', TRUE),
  ('63630000-0000-4000-8000-0000000000e1', '63630000-0000-4000-8000-000000000002', NULL),
  ('63630000-0000-4000-8000-0000000000e1', '63630000-0000-4000-8000-000000000003', NULL),
  ('63630000-0000-4000-8000-0000000000e1', '63630000-0000-4000-8000-000000000004', NULL),
  ('63630000-0000-4000-8000-0000000000e2', '63630000-0000-4000-8000-000000000001', NULL),
  ('63630000-0000-4000-8000-0000000000e2', '63630000-0000-4000-8000-000000000005', NULL),
  ('63630000-0000-4000-8000-0000000000e3', '63630000-0000-4000-8000-000000000006', NULL),
  ('63630000-0000-4000-8000-0000000000e4', '63630000-0000-4000-8000-000000000007', NULL),
  ('63630000-0000-4000-8000-0000000000e5', '63630000-0000-4000-8000-000000000001', NULL),
  ('63630000-0000-4000-8000-0000000000e5', '63630000-0000-4000-8000-000000000008', NULL);

-- Beendeter Törn: P zahlt 120 € „Gleichmäßig", davon 30 € Alkohol (Trinker:
-- P per Override, T per Personen-Flag); T zahlt 40 € „Gleichmäßig".
INSERT INTO transactions(trip_id, type, date, description, amount, alcohol_amount, paid_by, split_type) VALUES
  ('63630000-0000-4000-8000-0000000000e1', 'expense', '2020-06-03', 'Restaurant', 120, 30,
   '63630000-0000-4000-8000-000000000001', 'equal'),
  ('63630000-0000-4000-8000-0000000000e1', 'expense', '2020-06-04', 'Lebensmittel', 40, 0,
   '63630000-0000-4000-8000-000000000003', 'equal');

-- Laufender Törn: P zahlt, A isst nur mit.
INSERT INTO transactions(trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('63630000-0000-4000-8000-0000000000e2', 'expense', CURRENT_DATE, 'Lebensmittel', 60,
   '63630000-0000-4000-8000-000000000001', 'equal');

-- Törn E5: nur eine soft-gelöschte Buchung.
INSERT INTO transactions(trip_id, type, date, description, amount, paid_by, split_type, deleted_at) VALUES
  ('63630000-0000-4000-8000-0000000000e5', 'expense', '2020-08-03', 'Storniert', 50,
   '63630000-0000-4000-8000-000000000001', 'equal', now());

CREATE TEMP TABLE kl_snapshot AS
  SELECT person_id, balance FROM v_balances
   WHERE trip_id = '63630000-0000-4000-8000-0000000000e1';

-- ── 1. Mitesser im beendeten Törn ─────────────────────────────────────
SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000002'),
  'ok', 'Mitesser in beendetem Törn: Löschung liefert ok');

SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '63630000-0000-4000-8000-0000000000e1'
             AND person_id = '63630000-0000-4000-8000-000000000002'),
  'Mitesser bleibt (anonymisiert) Crew des Törns mit Buchungen');

SELECT is(
  (SELECT count(*) FROM kl_snapshot s
     FULL JOIN (SELECT person_id, balance FROM v_balances
                 WHERE trip_id = '63630000-0000-4000-8000-0000000000e1') v
       ON v.person_id = s.person_id
    WHERE s.person_id IS NULL OR v.person_id IS NULL OR s.balance IS DISTINCT FROM v.balance),
  0::bigint, 'v_balances nach Löschung des Mitessers unverändert (kein Anteil wandert)');

SELECT is(
  (SELECT SUM(balance) FROM v_balances WHERE trip_id = '63630000-0000-4000-8000-0000000000e1'),
  0::numeric, 'Σ v_balances = 0 nach Löschung des Mitessers');

-- ── 2. Trinker nur über das Personen-Flag ─────────────────────────────
SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000003'),
  'ok', 'Trinker mit Buchung in beendetem Törn: Löschung liefert ok');

SELECT is(
  (SELECT is_alcoholic FROM trip_members
    WHERE trip_id = '63630000-0000-4000-8000-0000000000e1'
      AND person_id = '63630000-0000-4000-8000-000000000003'),
  TRUE, 'Personen-Flag wird vor dem Zurücksetzen in die Mitgliedschaft übernommen');

SELECT is(
  (SELECT count(*) FROM kl_snapshot s
     FULL JOIN (SELECT person_id, balance FROM v_balances
                 WHERE trip_id = '63630000-0000-4000-8000-0000000000e1') v
       ON v.person_id = s.person_id
    WHERE s.person_id IS NULL OR v.person_id IS NULL OR s.balance IS DISTINCT FROM v.balance),
  0::bigint, 'v_balances nach Löschung des Trinkers unverändert (Alkoholanteil bleibt)');

SELECT is(
  (SELECT SUM(balance) FROM v_balances WHERE trip_id = '63630000-0000-4000-8000-0000000000e1'),
  0::numeric, 'Σ v_balances = 0 nach Löschung des Trinkers');

-- ── 3. Laufender / künftiger Törn ─────────────────────────────────────
SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000005'),
  'is_active_member', 'Mitglied eines laufenden Törns (ohne Buchung) → is_active_member');

SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '63630000-0000-4000-8000-0000000000e2'
             AND person_id = '63630000-0000-4000-8000-000000000005')
  AND EXISTS (SELECT 1 FROM persons_private WHERE person_id = '63630000-0000-4000-8000-000000000005')
  AND (SELECT display_name = 'KL Laufend' AND auth_user_id IS NOT NULL
         FROM persons WHERE id = '63630000-0000-4000-8000-000000000005'),
  'Blockiertes Mitglied bleibt unverändert (Mitgliedschaft, Kontaktdaten, Name, Login)');

SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000006'),
  'is_active_member', 'Mitglied eines künftigen Törns → is_active_member');

SELECT ok(
  EXISTS (SELECT 1 FROM trip_members
           WHERE trip_id = '63630000-0000-4000-8000-0000000000e3'
             AND person_id = '63630000-0000-4000-8000-000000000006')
  AND (SELECT display_name = 'KL Künftig' AND auth_user_id IS NOT NULL
         FROM persons WHERE id = '63630000-0000-4000-8000-000000000006'),
  'Blockiertes Mitglied des künftigen Törns bleibt unverändert');

-- ── 4. Beendete Törns ohne Buchungen ──────────────────────────────────
SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000007'),
  'ok', 'Mitglied eines beendeten Törns ohne Buchungen: ok');

SELECT is(
  (SELECT count(*) FROM trip_members WHERE person_id = '63630000-0000-4000-8000-000000000007'),
  0::bigint, 'Mitgliedschaft in einem Törn ohne Buchungen wird entfernt');

SELECT is(
  admin_delete_person_data('63630000-0000-4000-8000-000000000008'),
  'ok', 'Mitglied eines beendeten Törns mit nur soft-gelöschter Buchung: ok');

SELECT is(
  (SELECT count(*) FROM trip_members WHERE person_id = '63630000-0000-4000-8000-000000000008'),
  0::bigint, 'Soft-gelöschte Buchungen halten die Mitgliedschaft nicht');

-- ── 5. Seiteneingang geschlossen ──────────────────────────────────────
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'delete_my_account'),
  'delete_my_account() existiert nicht mehr');

SELECT * FROM finish();
ROLLBACK;
