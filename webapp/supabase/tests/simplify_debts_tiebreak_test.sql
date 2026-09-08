-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0055 (Sanierungsplan 2026-09, PR 9d,
-- Fund 21): simplify_debts() sortiert Schuldner/Gläubiger bei Gleichstand
-- jetzt deterministisch nach Person-ID (aufsteigend) als Sekundärschlüssel.
--
-- Ehrliche Grenze dieses Tests (empirisch geprüft, nicht nur vermutet):
-- ein Mutationstest — Migration 0055 testweise auf den alten Ein-Klausel-
-- Zustand zurückgesetzt (`ORDER BY open DESC` ohne `, id`) — lässt DIESEN
-- Test trotzdem grün bleiben. `v_balances_bordkasse_only` ist selbst schon
-- eine GROUP-BY-Aggregation; die Reihenfolge, in der Postgres deren Zeilen
-- ohne explizites zweites ORDER-BY-Kriterium liefert, folgt keiner von
-- dieser Testdatei kontrollierbaren Einfüge-Reihenfolge (anders als beim
-- TS-Mirror-Test in `__tests__/calc.test.ts`, wo `Array.sort`s
-- Stabilitätsgarantie das Einfüge-Reihenfolge-Argument tatsächlich trägt —
-- DORT ist der Mutationstest belastbar). Dieser SQL-Test prüft deshalb NUR
-- die tatsächlich implementierte, korrekte Ordnung (bei exakt gleichem
-- offenem Betrag gewinnt die lexikografisch kleinere Person-ID) — er
-- beweist nicht, dass ein Entfernen des Tiebreaks ihn zum Scheitern bringt.
-- Der TS-Mirror-Test trägt die Mutationsresistenz für diese Fix-Klasse.
--
-- Konvention (CLAUDE.md): Seed-UUIDs RFC-4122-valide — Versions-Nibble 4,
-- Variant 8. Alles in einer Transaktion, am Ende ROLLBACK → keine Spuren.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(4);

-- ── Setup: 2 Gläubiger (W, Y) + 2 Schuldner (X, Z), paarweise exakt
-- gleicher offener Betrag (20€), damit die Sortierung ausschließlich über
-- den ID-Tiebreak entschieden wird. Lexikografisch: Y < W (Gläubiger) und
-- X < Z (Schuldner). Die INSERT-Reihenfolge unten ist ohne Aussagekraft für
-- das Ergebnis (siehe Datei-Kopf) — Namen/Reihenfolge rein für Lesbarkeit.
INSERT INTO persons (id, display_name) VALUES
  ('dddddda1-0000-4000-8000-0000000000b2', 'W (Gläubiger, groß)'),
  ('dddddda1-0000-4000-8000-0000000000a2', 'Z (Schuldner, groß)'),
  ('dddddda1-0000-4000-8000-0000000000b1', 'Y (Gläubiger, klein)'),
  ('dddddda1-0000-4000-8000-0000000000a1', 'X (Schuldner, klein)');

INSERT INTO trips (id, name, start_date, end_date, skipper_id) VALUES
  ('dddddda1-0000-4000-8000-000000000001', 'Törn Tiebreak', '2026-07-01', '2026-07-05',
   'dddddda1-0000-4000-8000-0000000000b2');

INSERT INTO trip_members (trip_id, person_id) VALUES
  ('dddddda1-0000-4000-8000-000000000001', 'dddddda1-0000-4000-8000-0000000000b2'),
  ('dddddda1-0000-4000-8000-000000000001', 'dddddda1-0000-4000-8000-0000000000a2'),
  ('dddddda1-0000-4000-8000-000000000001', 'dddddda1-0000-4000-8000-0000000000b1'),
  ('dddddda1-0000-4000-8000-000000000001', 'dddddda1-0000-4000-8000-0000000000a1');

-- Txn 1: W streckt 20€ nur für X vor (per_person, W selbst kein Teilnehmer)
-- → W: +20 (Gläubiger), X: -20 (Schuldner).
INSERT INTO transactions (id, trip_id, type, date, amount, paid_by, split_type) VALUES
  ('dddddda1-0000-4000-8000-000000000010', 'dddddda1-0000-4000-8000-000000000001',
   'expense', '2026-07-02', 20, 'dddddda1-0000-4000-8000-0000000000b2', 'per_person');
INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
  ('dddddda1-0000-4000-8000-000000000010', 'dddddda1-0000-4000-8000-0000000000a1', 20);

-- Txn 2: Y streckt 20€ nur für Z vor → Y: +20 (Gläubiger), Z: -20 (Schuldner).
INSERT INTO transactions (id, trip_id, type, date, amount, paid_by, split_type) VALUES
  ('dddddda1-0000-4000-8000-000000000011', 'dddddda1-0000-4000-8000-000000000001',
   'expense', '2026-07-02', 20, 'dddddda1-0000-4000-8000-0000000000b1', 'per_person');
INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
  ('dddddda1-0000-4000-8000-000000000011', 'dddddda1-0000-4000-8000-0000000000a2', 20);

-- ── Erwartung: kleinste Schuldner-ID (X) zahlt an kleinste Gläubiger-ID
-- (Y), größte Schuldner-ID (Z) an größte Gläubiger-ID (W). ────────────────
SELECT is(
  (SELECT COUNT(*)::int FROM simplify_debts('dddddda1-0000-4000-8000-000000000001')),
  2, 'Tiebreak-Törn: 2 Schuldner, 2 Gläubiger, gleich hoch → 2 Überweisungen');

SELECT is(
  (SELECT to_person_id FROM simplify_debts('dddddda1-0000-4000-8000-000000000001')
    WHERE from_person_id = 'dddddda1-0000-4000-8000-0000000000a1'),
  'dddddda1-0000-4000-8000-0000000000b1'::uuid,
  'Tiebreak: kleinste Schuldner-ID (X) zahlt an kleinste Gläubiger-ID (Y)');

SELECT is(
  (SELECT to_person_id FROM simplify_debts('dddddda1-0000-4000-8000-000000000001')
    WHERE from_person_id = 'dddddda1-0000-4000-8000-0000000000a2'),
  'dddddda1-0000-4000-8000-0000000000b2'::uuid,
  'Tiebreak: größte Schuldner-ID (Z) zahlt an größte Gläubiger-ID (W)');

SELECT is(
  (SELECT ROUND(SUM(amount), 2) FROM simplify_debts('dddddda1-0000-4000-8000-000000000001')),
  40.00::numeric, 'Tiebreak-Törn: Σ Transfers = Σ Forderung (2× 20€), kein Cent verloren');

SELECT * FROM finish();
ROLLBACK;
