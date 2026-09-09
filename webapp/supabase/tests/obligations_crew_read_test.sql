-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0057: Anzahlungs-Soll für die ganze Crew
--
-- Vorher (0023) galt auf `prepayment_obligations` nur „Skipper ODER eigene
-- Zeile". Die Bilanz-Seite rendert den Anzahlungs-Pool aber ungegatet für
-- jedes Crewmitglied: das Ist kam aus `transactions` (member-lesbar), das
-- Soll wurde von RLS auf die eigene Zeile beschnitten → alle anderen kamen
-- als `soll = 0` an und bekamen wegen `soll <= 0.005 → "paid"` ein grünes
-- „bezahlt"-Häkchen. Nicht nur unvollständig, sondern falsch.
--
-- Geprüft wird funktional (nicht per Katalog-Abfrage), damit der Test auch
-- eine spätere, anders benannte Policy noch bewertet:
--   1. Ein normales Crewmitglied sieht ALLE Soll-Zeilen des Törns.
--   2. Ein Vorstrecker, der NICHT Trip-Skipper ist, ebenfalls — er verwaltet
--      laut App-Layer die Matrix. ⚠️ Die Policy wertet `advancer_person_id`
--      NICHT aus; der Fall trägt allein über die Mitglieds-Klausel. Das ist
--      ausreichend, weil `savePrepaymentPlan` den Vorstrecker per
--      `personsBelongToTrip` auf Trip-Mitglieder zwingt — der Check
--      dokumentiert also das Szenario, nicht einen eigenen Policy-Zweig.
--   3. Ein eingeloggter Fremder ohne Mitgliedschaft sieht weiterhin NICHTS.
--   4. Wer nicht (mehr) in trip_members steht, sieht wenigstens die eigene
--      Zeile (Self-Klausel, z. B. nach einem Crew-Wechsel).
--   5. Lesen heißt nicht schreiben: `authenticated` darf weiterhin NICHT
--      schreiben (Tabellenprivileg entzogen in 0050) — die günstigste
--      Absicherung dagegen, dass hier je aus Versehen ein `FOR ALL` landet.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(7);   -- 1 Definer-Vorcheck + 4 Lese-Checks + 2 Write-Lockdown-Checks

-- persons.auth_user_id trägt einen echten FK auf auth.users(id); von allen
-- Spalten dort ist nur `id` NOT NULL (gleiches Muster wie
-- purge_keep_transaction_facts_test.sql).
INSERT INTO auth.users(id) VALUES
  ('57570000-0000-4000-8000-0000000000f1'),   -- Skipper
  ('57570000-0000-4000-8000-0000000000f2'),   -- normale Crew
  ('57570000-0000-4000-8000-0000000000f3'),   -- Vorstrecker (kein Skipper)
  ('57570000-0000-4000-8000-0000000000f4'),   -- Fremder
  ('57570000-0000-4000-8000-0000000000f5');   -- Ex-Crew (nur Soll-Zeile)

INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('57570000-0000-4000-8000-000000000001', 'Obl Skipper',  '57570000-0000-4000-8000-0000000000f1'),
  ('57570000-0000-4000-8000-000000000002', 'Obl Crew',     '57570000-0000-4000-8000-0000000000f2'),
  ('57570000-0000-4000-8000-000000000003', 'Obl Advancer', '57570000-0000-4000-8000-0000000000f3'),
  ('57570000-0000-4000-8000-000000000004', 'Obl Fremd',    '57570000-0000-4000-8000-0000000000f4'),
  ('57570000-0000-4000-8000-000000000005', 'Obl ExCrew',   '57570000-0000-4000-8000-0000000000f5');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('57570000-0000-4000-8000-0000000000aa', 'pgTAP Obligations',
   '2027-04-05', '2027-04-15', '57570000-0000-4000-8000-000000000001');

-- Crew: Skipper, normales Mitglied, Vorstrecker. Der Vorstrecker ist
-- bewusst NICHT is_skipper — genau das war der zweite Treffer der Lücke.
INSERT INTO trip_members(trip_id, person_id, is_skipper) VALUES
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000001', TRUE),
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000002', FALSE),
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000003', FALSE);

INSERT INTO prepayment_plan(trip_id, split_method, total_amount, advancer_person_id) VALUES
  ('57570000-0000-4000-8000-0000000000aa', 'individuell', 900,
   '57570000-0000-4000-8000-000000000003');

-- Vier Soll-Zeilen: die drei Crewmitglieder + eine Ex-Crew-Person, die
-- keine trip_members-Zeile (mehr) hat.
INSERT INTO prepayment_obligations(trip_id, person_id, total_amount) VALUES
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000001', 300),
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000002', 300),
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000003', 300),
  ('57570000-0000-4000-8000-0000000000aa', '57570000-0000-4000-8000-000000000005', 150);

-- Definer-Rolle (BYPASSRLS): alle vier Zeilen existieren wirklich.
SELECT is(
  (SELECT count(*) FROM prepayment_obligations
   WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'),
  4::bigint, 'Definer-Rolle sieht alle 4 Soll-Zeilen (Daten existieren)');

-- ── 1. Normale Crew sieht ALLE Soll-Zeilen ────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '57570000-0000-4000-8000-0000000000f2')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM prepayment_obligations
   WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'),
  4::bigint, 'Normales Crewmitglied sieht alle Soll-Zeilen (Transparenz)');
RESET ROLE;

-- ── 2. Vorstrecker ohne Skipper-Rolle ebenfalls ───────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '57570000-0000-4000-8000-0000000000f3')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM prepayment_obligations
   WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'),
  4::bigint, 'Vorstrecker (nicht Skipper) sieht alle Soll-Zeilen für die Matrix');
RESET ROLE;

-- ── 3. Eingeloggter Fremder sieht NICHTS ──────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '57570000-0000-4000-8000-0000000000f4')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM prepayment_obligations
   WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Eingeloggter Fremder ohne Mitgliedschaft sieht 0 Soll-Zeilen');
RESET ROLE;

-- ── 4. Self-Klausel: Ex-Crew sieht die eigene Zeile ───────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '57570000-0000-4000-8000-0000000000f5')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM prepayment_obligations
   WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'),
  1::bigint, 'Person ohne trip_members-Zeile sieht weiterhin ihre eigene Soll-Zeile');
RESET ROLE;

-- ── 5. Schreiben bleibt für die Crew unmöglich ────────────────────────
-- Das Tabellenprivileg wird VOR RLS geprüft → 42501 (insufficient_privilege),
-- entzogen in 0050_revoke_dead_write_grants.sql. Geschrieben wird
-- ausschließlich über den Service-Role-Client in Server Actions.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '57570000-0000-4000-8000-0000000000f2')::text, TRUE);
SELECT throws_ok(
  $$UPDATE prepayment_obligations SET total_amount = 1
    WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'$$,
  '42501', NULL, 'Crewmitglied darf Soll-Beträge NICHT ändern');
SELECT throws_ok(
  $$DELETE FROM prepayment_obligations
    WHERE trip_id = '57570000-0000-4000-8000-0000000000aa'$$,
  '42501', NULL, 'Crewmitglied darf Soll-Beträge NICHT löschen');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
