-- ═══════════════════════════════════════════════════════════════════════
-- seed_demo.sql — Demo-Daten für /about Screenshots
-- Synthetische Crew (Anna, Ben, Clara, David, Eva) auf einem
-- Pfingst-Törn 18.–25. Mai 2026. Der Trip ist gestern zu Ende
-- gegangen (heute = 2026-05-26), damit der SettlementStatus-Banner
-- sichtbar wird („Bitte Kaution prüfen + Abrechnung verschicken").
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Auth-User-ID des Skippers (vorher via Admin-API angelegt)
  skipper_auth UUID := '7bf547a4-cdfc-4722-b603-946f5c6741fe';

  -- Personen
  p_anna   UUID := 'aaaaaaaa-0000-0000-0000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-0000-0000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-0000-0000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-0000-0000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-0000-0000-000000000005';

  -- Trip
  trip_demo UUID := 'bbbbbbbb-0000-0000-0000-000000000001';

  -- Kategorien
  c_lebensmittel UUID := 'cccccccc-0000-0000-0000-000000000001';
  c_restaurant   UUID := 'cccccccc-0000-0000-0000-000000000002';
  c_sprit        UUID := 'cccccccc-0000-0000-0000-000000000003';
  c_yacht        UUID := 'cccccccc-0000-0000-0000-000000000004';
  c_hafen        UUID := 'cccccccc-0000-0000-0000-000000000005';
  c_ausruestung  UUID := 'cccccccc-0000-0000-0000-000000000006';
  c_versicherung UUID := 'cccccccc-0000-0000-0000-000000000007';
  c_sonstiges    UUID := 'cccccccc-0000-0000-0000-000000000008';

  -- Transaktionen
  tx UUID;
BEGIN
  -- Erst: alten Test-Seed entfernen (Trip "Test-Törn April 2026")
  DELETE FROM trips WHERE id = '22222222-2222-2222-2222-000000000001';
  DELETE FROM persons WHERE id IN (
    '11111111-1111-1111-1111-000000000001',
    '11111111-1111-1111-1111-000000000002',
    '11111111-1111-1111-1111-000000000003',
    '11111111-1111-1111-1111-000000000004',
    '11111111-1111-1111-1111-000000000005',
    '11111111-1111-1111-1111-000000000006',
    '11111111-1111-1111-1111-000000000007',
    '11111111-1111-1111-1111-000000000008',
    '11111111-1111-1111-1111-000000000009',
    '11111111-1111-1111-1111-00000000000a'
  );

  -- ── Personen ─────────────────────────────────────────────────────────
  -- email lebt seit 0013_privacy in persons_private, nicht mehr in persons
  INSERT INTO persons (id, auth_user_id, display_name, is_alcoholic) VALUES
    (p_anna,  skipper_auth, 'Anna',  TRUE),
    (p_ben,   NULL,         'Ben',   FALSE),
    (p_clara, NULL,         'Clara', TRUE),
    (p_david, NULL,         'David', FALSE),
    (p_eva,   NULL,         'Eva',   FALSE);

  INSERT INTO persons_private (person_id, email) VALUES
    (p_anna,  'skipper@example.com'),
    (p_ben,   'ben@example.com'),
    (p_clara, 'clara@example.com');

  -- ── Trip ─────────────────────────────────────────────────────────────
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id) VALUES
    (trip_demo, 'Pfingst-Törn Ostsee 2026', '2026-05-18', '2026-05-25', 'Sea Spirit', p_anna);

  -- ── Crew ─────────────────────────────────────────────────────────────
  -- Eva kommt erst am 22.05. dazu (Donnerstag), Rest den ganzen Törn
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, note) VALUES
    (trip_demo, p_anna,  NULL,         NULL, 'Skipperin'),
    (trip_demo, p_ben,   NULL,         NULL, NULL),
    (trip_demo, p_clara, NULL,         NULL, NULL),
    (trip_demo, p_david, NULL,         NULL, NULL),
    (trip_demo, p_eva,   '2026-05-22', NULL, 'Steigt in Heiligenhafen zu');

  -- ── Kategorien (Default-Set) ─────────────────────────────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (c_lebensmittel, trip_demo, 'Lebensmittel',      '🛒',  1),
    (c_restaurant,   trip_demo, 'Restaurant',        '🍽️', 2),
    (c_sprit,        trip_demo, 'Sprit',             '⛽',  3),
    (c_yacht,        trip_demo, 'Yacht',             '⛵',  4),
    (c_hafen,        trip_demo, 'Hafen / Liegeplatz','⚓',  5),
    (c_ausruestung,  trip_demo, 'Ausrüstung',        '🛠️', 6),
    (c_versicherung, trip_demo, 'Versicherung',      '🛡️', 7),
    (c_sonstiges,    trip_demo, 'Sonstiges',         '📦',  8);

  -- ── Buchungen ────────────────────────────────────────────────────────
  -- 1. Lebensmittel Edeka — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-18', 'Edeka Großeinkauf', 78.40, p_anna, c_lebensmittel, 'equal', p_anna);

  -- 2. Restaurant Hafenkrug — an Bord, mit Alkohol
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-19', 'Hafenkrug Travemünde', 124.50, 30.00, p_ben, c_restaurant, 'on_board', p_anna);

  -- 3. Sprit Diesel — zeitanteilig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-20', 'Diesel Heiligenhafen', 86.20, p_anna, c_sprit, 'time_proportional', p_anna);

  -- 4. Marina-Liegegebühr — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-20', 'Marina Heiligenhafen', 45.00, p_clara, c_hafen, 'equal', p_anna);

  -- 5. Brötchen morgens — an Bord
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-22', 'Bäcker Brötchen', 12.80, p_david, c_lebensmittel, 'on_board', p_anna);

  -- 6. Schwimmwesten — individuell (nur Ben + David)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-18', 'Schwimmwesten neu', 65.00, p_ben, c_ausruestung, 'individual', p_anna);
  INSERT INTO transaction_participants (transaction_id, person_id) VALUES
    (tx, p_ben), (tx, p_david);

  -- 7. Bier-Einkauf — Alkohol-Betrag = Gesamtbetrag (zahlen nur Trinker)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-19', 'Getränkemarkt', 38.50, 38.50, p_clara, c_lebensmittel, 'equal', p_anna);

  -- 8. Hafen Maasholm — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-23', 'Hafen Maasholm', 28.00, p_anna, c_hafen, 'equal', p_anna);

  -- 9. Restaurant „Pro Person" — jeder zahlt seine eigene Bestellung
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_demo, 'expense', '2026-05-24', 'Strandrestaurant Maasholm', 88.90, p_anna, c_restaurant, 'per_person', p_anna);
  -- Pro-Person-Beträge stehen in transaction_participants.amount
  INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
    (tx, p_anna,  22.50),
    (tx, p_ben,   16.80),
    (tx, p_clara, 19.40),
    (tx, p_david, 14.20),
    (tx, p_eva,   16.00);

  -- ── Gutschrift ───────────────────────────────────────────────────────
  -- Anna hat 200€ Yacht-Vorauszahlung an die Crew
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, created_by)
    VALUES (tx, trip_demo, 'credit', '2026-05-18', 'Yacht-Vorauszahlung', 200.00, p_anna, NULL, p_anna);
END $$;
