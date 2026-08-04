-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0047 (Code-Review 2026-08, Fund 1):
-- alle Schreib-Pfade laufen über den Service-Role-Client, nicht über den
-- Cookie-/Browser-Client. Diese Datei beweist, dass ein normales,
-- eingeloggtes Crewmitglied — OHNE App-Code, direkt per PostgREST-Data-API
-- (simuliert über `SET LOCAL ROLE authenticated` + `request.jwt.claims`) —
-- keine der folgenden Eskalationen mehr durchführen kann:
--
--   1. sich selbst zum Co-Skipper befördern (trip_members.is_skipper)
--   2. die eigene Anwesenheit/den Alkohol-Status frei verstellen
--   3. eine Gutschrift direkt anlegen (App: Skipper/Admin-only)
--   4. eine fremde Buchung physisch löschen (App: nur Soft-Delete)
--   5. deleted_at selbst fälschen (Soft-Delete ohne Audit-Log-Eintrag)
--
-- Gegenprobe (Fund 1 darf NICHT zu Über-Härtung führen): der Cookie-Client
-- muss weiterhin lesen können — sonst bricht z. B. Realtime.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(9);

-- ── Setup: Skipper P1 + normales Mitglied P2, beide mit Login, ein Törn
-- mit einer Ausgabe, damit es etwas zu manipulieren/lesen gibt. ──────────
INSERT INTO auth.users(id) VALUES
  ('47470000-0000-4000-8000-0000000000f1'),
  ('47470000-0000-4000-8000-0000000000f2');

INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('47470000-0000-4000-8000-000000000001', 'RLS-Lock P1 (Skipper)', '47470000-0000-4000-8000-0000000000f1'),
  ('47470000-0000-4000-8000-000000000002', 'RLS-Lock P2 (Crew)',    '47470000-0000-4000-8000-0000000000f2');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('47470000-0000-4000-8000-0000000000aa', 'pgTAP Write-RLS-Lockdown',
   '2026-05-01', '2026-05-10', '47470000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id, is_skipper, on_board_from, on_board_to) VALUES
  ('47470000-0000-4000-8000-0000000000aa', '47470000-0000-4000-8000-000000000001', TRUE, NULL, NULL),
  ('47470000-0000-4000-8000-0000000000aa', '47470000-0000-4000-8000-000000000002', FALSE, NULL, NULL);

INSERT INTO transactions(id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('47470000-0000-4000-8000-0000000000e1', '47470000-0000-4000-8000-0000000000aa',
   'expense', '2026-05-02', 'Lebensmittel', 60,
   '47470000-0000-4000-8000-000000000001', 'equal');

-- ── Als P2 (normales Crewmitglied, NICHT Skipper) impersonieren ───────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '47470000-0000-4000-8000-0000000000f2')::text, TRUE);

-- 1. Selbst-Beförderung zum Co-Skipper: kein UPDATE-Policy mehr → 0 Zeilen.
WITH u AS (
  UPDATE trip_members SET is_skipper = TRUE
   WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
     AND person_id = '47470000-0000-4000-8000-000000000002'
  RETURNING 1
)
SELECT is((SELECT count(*) FROM u), 0::bigint,
  'Crew kann sich nicht per direktem UPDATE selbst zum Co-Skipper machen');

-- 2. Eigene Anwesenheit manipulieren: ebenfalls 0 Zeilen.
WITH u AS (
  UPDATE trip_members SET on_board_from = '2099-01-01', on_board_to = '2099-01-02'
   WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
     AND person_id = '47470000-0000-4000-8000-000000000002'
  RETURNING 1
)
SELECT is((SELECT count(*) FROM u), 0::bigint,
  'Crew kann eigene Anwesenheit nicht per direktem UPDATE manipulieren');

-- 3. Gutschrift direkt anlegen (App: Skipper/Admin-only): kein INSERT-
-- Policy mehr → RLS lehnt mit 42501 ab, statt die Zeile stillschweigend
-- zu übernehmen.
SELECT throws_ok(
  $$INSERT INTO transactions(trip_id, type, date, amount, credit_from, credit_to)
    VALUES ('47470000-0000-4000-8000-0000000000aa', 'credit', CURRENT_DATE, 500,
            '47470000-0000-4000-8000-000000000002', '47470000-0000-4000-8000-000000000001')$$,
  '42501', NULL,
  'Crew kann keine Gutschrift per direktem INSERT anlegen');

-- 4. Fremde Buchung physisch löschen: 0 Zeilen (kein DELETE-Policy mehr).
WITH d AS (
  DELETE FROM transactions WHERE id = '47470000-0000-4000-8000-0000000000e1'
  RETURNING 1
)
SELECT is((SELECT count(*) FROM d), 0::bigint,
  'Crew kann eine Buchung nicht per direktem DELETE hart löschen');

-- 5. deleted_at selbst fälschen (Soft-Delete ohne Audit-Spur): 0 Zeilen.
WITH u AS (
  UPDATE transactions SET deleted_at = now()
   WHERE id = '47470000-0000-4000-8000-0000000000e1'
  RETURNING 1
)
SELECT is((SELECT count(*) FROM u), 0::bigint,
  'Crew kann deleted_at nicht per direktem UPDATE selbst setzen');

-- ── Gegenprobe: keine Über-Härtung — Lesen funktioniert weiterhin ─────
SELECT is(
  (SELECT is_skipper FROM trip_members
    WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'
      AND person_id = '47470000-0000-4000-8000-000000000002'),
  FALSE, 'is_skipper ist unverändert FALSE geblieben');

SELECT is(
  (SELECT deleted_at FROM transactions WHERE id = '47470000-0000-4000-8000-0000000000e1'),
  NULL::timestamptz, 'deleted_at ist unverändert NULL geblieben');

SELECT is(
  (SELECT count(*) FROM transactions WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'),
  1::bigint, 'Crew liest die (unangetastete) Buchung weiterhin per RLS-SELECT');

SELECT is(
  (SELECT count(*) FROM trip_members WHERE trip_id = '47470000-0000-4000-8000-0000000000aa'),
  2::bigint, 'Crew liest die Crew-Liste weiterhin per RLS-SELECT');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
