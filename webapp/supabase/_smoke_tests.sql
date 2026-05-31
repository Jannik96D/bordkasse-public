-- ═══════════════════════════════════════════════════════════════════════
-- _smoke_tests.sql — Manueller Sanity-Check der Views/Function
-- Aufruf:  psql ... -f supabase/_smoke_tests.sql
--
-- Erwartete Ergebnisse aus docs/calculation-rules.md §S1, S4, S6, S7.
-- (Wird NICHT von `supabase db reset` ausgeführt.)
-- ═══════════════════════════════════════════════════════════════════════

\echo '── Setup-Check: Crew + Tage ─────────────────────────────────────────'
SELECT p.display_name, v.days_aboard, v.is_alcoholic
FROM v_trip_members_with_days v
JOIN persons p ON p.id = v.person_id
WHERE trip_id = '22222222-2222-4222-8222-000000000001'
ORDER BY days_aboard DESC, display_name;
-- Erwartung: 9 Personen × 11 Tage, Stephan 6 Tage, 105 Personentage gesamt.
-- Trinker: Dario, Tim, Emma.

\echo '\n── S1: 100€ Lebensmittel von Jannik, Gleichmäßig ────────────────────'
INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, split_type)
VALUES (
  '99999999-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-000000000001',
  'expense',
  '2026-04-06',
  'Lebensmittel S1',
  100.00,
  '11111111-1111-4111-8111-000000000001',  -- Jannik
  'equal'
);

SELECT p.display_name, ROUND(s.share, 2) AS share
FROM v_transaction_shares s
JOIN persons p ON p.id = s.person_id
WHERE s.transaction_id = '99999999-0000-4000-8000-000000000001'
ORDER BY p.display_name;
-- Erwartung: jeder 10.00€

\echo '\n── S4: 210€ Sprit von Jannik, Zeitanteilig ──────────────────────────'
INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, split_type)
VALUES (
  '99999999-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-000000000001',
  'expense',
  '2026-04-08',
  'Sprit S4',
  210.00,
  '11111111-1111-4111-8111-000000000001',
  'time_proportional'
);

SELECT p.display_name, ROUND(s.share, 2) AS share
FROM v_transaction_shares s
JOIN persons p ON p.id = s.person_id
WHERE s.transaction_id = '99999999-0000-4000-8000-000000000004'
ORDER BY share DESC, p.display_name;
-- Erwartung: 9× 22.00€ (11-Tage-Personen), Stephan 12.00€

\echo '\n── S3: 100€ Restaurant am 12.04. mit 30€ Alkohol, An Bord ──────────'
INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, split_type)
VALUES (
  '99999999-0000-4000-8000-000000000003',
  '22222222-2222-4222-8222-000000000001',
  'expense',
  '2026-04-12',
  'Restaurant S3',
  100.00,
  30.00,
  '11111111-1111-4111-8111-000000000001',
  'on_board'
);

SELECT p.display_name, ROUND(s.share, 2) AS share, p.is_alcoholic
FROM v_transaction_shares s
JOIN persons p ON p.id = s.person_id
WHERE s.transaction_id = '99999999-0000-4000-8000-000000000003'
ORDER BY share DESC, p.display_name;
-- Erwartung: Trinker 17.00€, Andere 7.00€, Summe-Check 100€

\echo '\n── Bilanz nach S1 + S4 + S3 ─────────────────────────────────────────'
SELECT p.display_name, ROUND(b.paid, 2) paid, ROUND(b.share, 2) share, ROUND(b.balance, 2) balance
FROM v_balances b
JOIN persons p ON p.id = b.person_id
WHERE b.trip_id = '22222222-2222-4222-8222-000000000001'
ORDER BY balance DESC;

\echo '\n── Cleanup S1+S3+S4 für nächste Tests ───────────────────────────────'
DELETE FROM transactions
WHERE id IN (
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000003',
  '99999999-0000-4000-8000-000000000004'
);

\echo '\n── S7: Schulden-Greedy mit 300€ + 150€ ──────────────────────────────'
-- S7 setzt ALLE 10 da. Dafür kurz Stephan auf "ab Törn-Start" setzen.
UPDATE trip_members
   SET on_board_from = NULL
 WHERE trip_id = '22222222-2222-4222-8222-000000000001'
   AND person_id = '11111111-1111-4111-8111-000000000006';

INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, split_type) VALUES
  ('99999999-0000-4000-8000-000000000007',
   '22222222-2222-4222-8222-000000000001',
   'expense', '2026-04-06', 'S7-Test 300€', 300.00,
   '11111111-1111-4111-8111-000000000001', 'equal'),
  ('99999999-0000-4000-8000-000000000008',
   '22222222-2222-4222-8222-000000000001',
   'expense', '2026-04-07', 'S7-Test 150€', 150.00,
   '11111111-1111-4111-8111-000000000005', 'on_board');

SELECT p.display_name, ROUND(b.balance, 2) balance
FROM v_balances b
JOIN persons p ON p.id = b.person_id
WHERE b.trip_id = '22222222-2222-4222-8222-000000000001'
ORDER BY balance DESC;
-- Erwartung: Jannik +255, Emma +105, alle anderen je -45

SELECT from_name, to_name, amount
FROM simplify_debts('22222222-2222-4222-8222-000000000001');
-- Erwartung: 9 Überweisungen, 5× je 45 an Jannik, dann split

\echo '\n── Cleanup S7 ───────────────────────────────────────────────────────'
DELETE FROM transactions
WHERE id IN (
  '99999999-0000-4000-8000-000000000007',
  '99999999-0000-4000-8000-000000000008'
);
UPDATE trip_members
   SET on_board_from = '2026-04-10'
 WHERE trip_id = '22222222-2222-4222-8222-000000000001'
   AND person_id = '11111111-1111-4111-8111-000000000006';

\echo '\n✅ Smoke-Tests durchgelaufen.'
