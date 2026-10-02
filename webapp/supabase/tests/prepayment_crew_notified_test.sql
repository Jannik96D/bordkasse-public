-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0062: Benachrichtigungs-Zeitstempel (PR6).
--
-- Geprüft:
--   1. Die drei Spalten existieren, sind nullable und ohne Default (ein
--      Default now() würde jeden neuen Plan als „schon informiert" markieren
--      und die Mail „Anzahlungsplan angelegt" nie auslösen).
--   2. Einmal-Claim: UPDATE … WHERE crew_notified_at IS NULL trifft genau
--      einmal, der zweite Versuch 0 Zeilen (Grundlage für „genau einmal").
--   3. Ein eingeloggtes Crewmitglied kann die Flags nicht setzen/zurück-
--      setzen (sonst ließe sich der Einmal-Versand erneut auslösen).
--   3b. Backfill aus 0062: Plan MIT Tranche wird markiert, Plan OHNE
--      Tranche bleibt NULL (das Statement ist 1:1 aus der Migration kopiert —
--      bei einer Änderung dort hier nachziehen).
--   4. Purge eines abgerechneten Törns läuft mit gesetzten Flags durch und
--      räumt Plan + Posten weiterhin ab (keine neue Abhängigkeit).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(17);

-- ── 1. Spalten ────────────────────────────────────────────────────────
SELECT has_column('public', 'prepayment_plan', 'crew_notified_at', 'prepayment_plan.crew_notified_at existiert');
SELECT has_column('public', 'prepayment_plan', 'crew_last_notified_at', 'prepayment_plan.crew_last_notified_at existiert');
SELECT has_column('public', 'prepayment_items', 'crew_last_notified_at', 'prepayment_items.crew_last_notified_at existiert');
SELECT col_is_null('public', 'prepayment_plan', 'crew_notified_at', 'crew_notified_at ist nullable');
SELECT col_hasnt_default('public', 'prepayment_plan', 'crew_notified_at', 'crew_notified_at ohne Default');
SELECT col_hasnt_default('public', 'prepayment_items', 'crew_last_notified_at', 'Posten-Zeitstempel ohne Default');

-- ── Setup ─────────────────────────────────────────────────────────────
INSERT INTO auth.users(id) VALUES ('62620000-0000-4000-8000-0000000000f1');
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('62620000-0000-4000-8000-000000000001', 'N Skipper', NULL),
  ('62620000-0000-4000-8000-000000000002', 'N Crew', '62620000-0000-4000-8000-0000000000f1');
INSERT INTO trips(id, name, start_date, end_date, skipper_id, settlement_announced_at) VALUES
  ('62620000-0000-4000-8000-0000000000aa', 'pgTAP Notify', '2020-04-01', '2020-04-10',
   '62620000-0000-4000-8000-000000000001', now());
INSERT INTO trip_members(trip_id, person_id) VALUES
  ('62620000-0000-4000-8000-0000000000aa', '62620000-0000-4000-8000-000000000001'),
  ('62620000-0000-4000-8000-0000000000aa', '62620000-0000-4000-8000-000000000002');
INSERT INTO prepayment_plan(trip_id, split_method, total_amount)
  VALUES ('62620000-0000-4000-8000-0000000000aa', 'gleichmaessig', 1000);
INSERT INTO prepayment_items(id, trip_id, label, total_amount, payee_person_id, split_type)
  VALUES ('62620000-0000-4000-8000-0000000000d1', '62620000-0000-4000-8000-0000000000aa', 'Flüge', 100,
          '62620000-0000-4000-8000-000000000001', 'gleichmaessig');

SELECT is(
  (SELECT crew_notified_at FROM prepayment_plan WHERE trip_id = '62620000-0000-4000-8000-0000000000aa'),
  NULL, 'neuer Plan ist noch nicht informiert');

-- ── 2. Einmal-Claim ───────────────────────────────────────────────────
WITH c AS (
  UPDATE prepayment_plan SET crew_notified_at = now()
   WHERE trip_id = '62620000-0000-4000-8000-0000000000aa' AND crew_notified_at IS NULL
  RETURNING trip_id)
SELECT is((SELECT count(*) FROM c), 1::bigint, 'erster Claim trifft die Zeile');
WITH c AS (
  UPDATE prepayment_plan SET crew_notified_at = now()
   WHERE trip_id = '62620000-0000-4000-8000-0000000000aa' AND crew_notified_at IS NULL
  RETURNING trip_id)
SELECT is((SELECT count(*) FROM c), 0::bigint, 'zweiter Claim trifft nichts (genau einmal)');

-- ── 3. Crewmitglied kann die Flags nicht anfassen ─────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '62620000-0000-4000-8000-0000000000f1', 'role', 'authenticated')::text, TRUE);
-- Je nach GRANT-Stand: Fehler 42501 oder 0 betroffene Zeilen (RLS ohne
-- Write-Policy, 0050). Beides heißt „nicht geschrieben" — geprüft wird
-- unten das Ergebnis als Superuser.
-- Zwei getrennte Blöcke: wirft das erste UPDATE, liefe ein zweites im selben
-- Block nie (Review-Fund) und der Posten-Check wäre wertlos.
DO $$
BEGIN
  UPDATE prepayment_plan SET crew_notified_at = NULL WHERE trip_id = '62620000-0000-4000-8000-0000000000aa';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  UPDATE prepayment_items SET crew_last_notified_at = now() WHERE id = '62620000-0000-4000-8000-0000000000d1';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
SELECT isnt(
  (SELECT crew_notified_at FROM prepayment_plan WHERE trip_id = '62620000-0000-4000-8000-0000000000aa'),
  NULL, 'Crewmitglied kann den Einmal-Claim nicht zurücksetzen');
SELECT is(
  (SELECT crew_last_notified_at FROM prepayment_items WHERE id = '62620000-0000-4000-8000-0000000000d1'),
  NULL, 'Crewmitglied kann den Posten-Zeitstempel nicht setzen');

-- ── 3b. Backfill ──────────────────────────────────────────────────────
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('62620000-0000-4000-8000-0000000000b1', 'pgTAP Backfill mit', '2099-01-01', '2099-01-05', '62620000-0000-4000-8000-000000000001'),
  ('62620000-0000-4000-8000-0000000000b2', 'pgTAP Backfill ohne', '2099-01-01', '2099-01-05', '62620000-0000-4000-8000-000000000001');
INSERT INTO prepayment_plan(trip_id, split_method, total_amount) VALUES
  ('62620000-0000-4000-8000-0000000000b1', 'gleichmaessig', 100),
  ('62620000-0000-4000-8000-0000000000b2', 'gleichmaessig', 100);
INSERT INTO prepayment_tranches(trip_id, due_date, label, percent)
  VALUES ('62620000-0000-4000-8000-0000000000b1', '2098-12-01', 'Endzahlung', 100);
SELECT is(
  (SELECT count(*) FROM prepayment_plan
    WHERE trip_id IN ('62620000-0000-4000-8000-0000000000b1', '62620000-0000-4000-8000-0000000000b2')
      AND crew_notified_at IS NULL),
  2::bigint, 'Backfill-Fixtures starten uninformiert');
-- 1:1 aus 0062:
UPDATE prepayment_plan p
   SET crew_notified_at = now()
 WHERE p.crew_notified_at IS NULL
   AND EXISTS (SELECT 1 FROM prepayment_tranches t WHERE t.trip_id = p.trip_id);
SELECT isnt(
  (SELECT crew_notified_at FROM prepayment_plan WHERE trip_id = '62620000-0000-4000-8000-0000000000b1'),
  NULL, 'Backfill markiert einen Plan MIT Tranchen als informiert');
SELECT is(
  (SELECT crew_notified_at FROM prepayment_plan WHERE trip_id = '62620000-0000-4000-8000-0000000000b2'),
  NULL, 'Backfill lässt einen Plan OHNE Tranchen uninformiert (erste Mail kommt noch)');

-- ── 4. Purge ──────────────────────────────────────────────────────────
UPDATE prepayment_items SET crew_last_notified_at = now() WHERE id = '62620000-0000-4000-8000-0000000000d1';
UPDATE prepayment_plan SET crew_last_notified_at = now() WHERE trip_id = '62620000-0000-4000-8000-0000000000aa';
SELECT is(
  purge_trip_data('62620000-0000-4000-8000-0000000000aa', FALSE),
  'ok', 'Purge läuft mit gesetzten Benachrichtigungs-Flags durch');
SELECT is(
  (SELECT count(*) FROM prepayment_plan WHERE trip_id = '62620000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Purge löscht den Plan weiterhin');
SELECT is(
  (SELECT count(*) FROM prepayment_items WHERE trip_id = '62620000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Purge löscht die Posten weiterhin');

SELECT * FROM finish();
ROLLBACK;
