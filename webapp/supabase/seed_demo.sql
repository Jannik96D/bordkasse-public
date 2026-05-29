-- ═══════════════════════════════════════════════════════════════════════
-- seed_demo.sql — Demo-Daten für /about Screenshots
-- Synthetische Crew (Anna, Ben, Clara, David, Eva) auf einem
-- Pfingst-Törn 18.–25. Mai 2026. Der Trip ist gestern zu Ende
-- gegangen (heute = 2026-05-26), damit der SettlementStatus-Banner
-- sichtbar wird („Bitte Kaution prüfen + Abrechnung verschicken").
-- ═══════════════════════════════════════════════════════════════════════

-- HINWEIS: Auth-User für Anna (skipper@example.com) und Clara
-- (clara@example.com) werden NICHT von diesem File angelegt — die
-- aktuelle Supabase-Version akzeptiert nur Auth-User, die per Admin-API
-- erzeugt wurden (sonst "Database error finding user" beim Login).
-- Stattdessen `scripts/seed-demo.sh` benutzen, das diese User korrekt
-- anlegt UND danach persons.auth_user_id nachträgt.
--
-- Falls du dieses File direkt einspielst (ohne seed-demo.sh), ist Login
-- nicht möglich — die Daten sind nur als Read-State sichtbar.

DO $$
DECLARE
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
  -- email lebt seit 0013_privacy in persons_private, nicht mehr in persons.
  -- auth_user_id wird von seed-demo.sh nachträglich gesetzt (für Anna +
  -- Clara). Hier alle NULL, damit kein FK-Konflikt entsteht.
  INSERT INTO persons (id, auth_user_id, display_name, is_alcoholic) VALUES
    (p_anna,  NULL, 'Anna',  TRUE),
    (p_ben,   NULL, 'Ben',   FALSE),
    (p_clara, NULL, 'Clara', TRUE),
    (p_david, NULL, 'David', FALSE),
    (p_eva,   NULL, 'Eva',   FALSE);

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

-- ═══════════════════════════════════════════════════════════════════════
-- ZWEITER DEMO-TRIP: Bareboat-Charter Sommer 2027 mit Anzahlungs-Plan
-- Zukünftiger Törn, Kojen-Aufteilung, Anna ist Vorstrecker, 2 Tranchen.
-- Liefert die Daten für die /about Screenshots zum Anzahlungs-Modul.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Personen (gleicher Skipper Anna, plus Ben/Clara/David/Eva aus dem
  -- ersten Trip — wir referenzieren sie über ihre festen UUIDs).
  p_anna   UUID := 'aaaaaaaa-0000-0000-0000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-0000-0000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-0000-0000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-0000-0000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-0000-0000-000000000005';

  -- Auth-User für Clara wird via Admin-API in seed-demo.sh angelegt.
  -- persons.auth_user_id wird dort nachgetragen, damit Clara sich
  -- einloggen kann und Crew-Self-View sieht (Skipper-Trip = Anna).

  trip_charter UUID := 'bbbbbbbb-0000-0000-0000-000000000002';

  -- Kategorien (eigene Liste pro Trip)
  c_yacht        UUID := 'cccccccc-0000-0000-0000-000000000101';
  c_lebensmittel UUID := 'cccccccc-0000-0000-0000-000000000102';
  c_sprit        UUID := 'cccccccc-0000-0000-0000-000000000103';
  c_hafen        UUID := 'cccccccc-0000-0000-0000-000000000104';
  c_versicherung UUID := 'cccccccc-0000-0000-0000-000000000105';

  -- Anzahlungs-Module
  cabin_doppel UUID := 'dddddddd-0000-0000-0000-000000000201';
  cabin_einzel UUID := 'dddddddd-0000-0000-0000-000000000202';
  tranche_1    UUID := 'eeeeeeee-0000-0000-0000-000000000201';
  tranche_2    UUID := 'eeeeeeee-0000-0000-0000-000000000202';

  tx UUID;
BEGIN
  -- ── Aufräumen falls schon vorhanden ──────────────────────────────────
  DELETE FROM trips WHERE id = trip_charter;

  -- ── Trip ─────────────────────────────────────────────────────────────
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id) VALUES
    (trip_charter, 'Bareboat-Charter Sommer 2027', '2027-07-10', '2027-07-17', 'Bavaria 42', p_anna);

  -- ── Crew (alle den ganzen Törn) ──────────────────────────────────────
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, note) VALUES
    (trip_charter, p_anna,  NULL, NULL, 'Skipperin · Vorstrecker'),
    (trip_charter, p_ben,   NULL, NULL, NULL),
    (trip_charter, p_clara, NULL, NULL, NULL),
    (trip_charter, p_david, NULL, NULL, NULL),
    (trip_charter, p_eva,   NULL, NULL, NULL);

  -- ── Kategorien (Default-Set mit lucide-Icon-Namen) ───────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (c_yacht,        trip_charter, 'Yacht',         'Sailboat',     1),
    (c_lebensmittel, trip_charter, 'Lebensmittel',  'ShoppingCart', 2),
    (c_sprit,        trip_charter, 'Sprit',         'Fuel',         3),
    (c_hafen,        trip_charter, 'Hafen',         'Anchor',       4),
    (c_versicherung, trip_charter, 'Versicherung',  'ShieldCheck',  5);

  -- ── Anzahlungs-Plan: 3500€ Yacht, Kojen-Aufteilung ───────────────────
  INSERT INTO prepayment_plan (trip_id, split_method, total_amount, advancer_person_id, wero_id) VALUES
    (trip_charter, 'kojen', 3500.00, p_anna, 'anna.h');

  -- ── Kojen ────────────────────────────────────────────────────────────
  -- Anna in der Kapitänskabine 800€, andere vier paarweise in Doppelkoje 675€/Person.
  -- Doppelkoje capacity = 4 (zwei Bettpaare im selben Kabinen-Typ —
  -- die Wizard-Validierung prüft Belegung gegen Plätze, nicht gegen
  -- physische Kabinen). Sonst gäbe es bei 4 Doppelkojen-Personen einen
  -- „Überbelegung!"-Fehler im Wizard-Step 1.
  INSERT INTO cabin_types (id, trip_id, label, price_per_person, capacity, sort_order) VALUES
    (cabin_einzel, trip_charter, 'Kapitänskabine', 800.00, 1, 1),
    (cabin_doppel, trip_charter, 'Doppelkoje',     675.00, 4, 2);

  -- ── Obligations (Soll pro Person) ────────────────────────────────────
  INSERT INTO prepayment_obligations (trip_id, person_id, cabin_type_id, total_amount) VALUES
    (trip_charter, p_anna,  cabin_einzel, 800.00),
    (trip_charter, p_ben,   cabin_doppel, 675.00),
    (trip_charter, p_clara, cabin_doppel, 675.00),
    (trip_charter, p_david, cabin_doppel, 675.00),
    (trip_charter, p_eva,   cabin_doppel, 675.00);

  -- ── Tranchen (30% Reservierung in ~10 Tagen, 70% Endzahlung 2027) ──
  -- due_date 2026-06-05 fällt 10 Tage nach „heute" (2026-05-26) → Banner
  -- zeigt „in 10 Tagen fällig"-Warnung (soon-Indikator), kein overdue.
  INSERT INTO prepayment_tranches (id, trip_id, due_date, label, percent, sort_order) VALUES
    (tranche_1, trip_charter, '2026-06-05', 'Reservierungs-Anzahlung', 30, 1),
    (tranche_2, trip_charter, '2027-04-15', 'Endzahlung',              70, 2);

  -- ── Crew-Zahlungen an Anna (Vorstrecker) ─────────────────────────────
  -- Anna: Selbst-Credit (bilanzneutral, Migration 0024 erlaubt das bei
  -- tranche-getaggten Buchungen) — sie hat ihren Anteil „bei sich selbst".
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_charter, 'credit', '2026-05-10', 'Anzahlung Reservierung (Selbst)', 240.00, p_anna, p_anna, tranche_1, p_anna, now());

  -- Ben: Tranche 1 voll bezahlt (202.50€)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_charter, 'credit', '2026-05-12', 'Anzahlung Reservierung', 202.50, p_ben, p_anna, tranche_1, p_anna, now());

  -- Clara: Teilzahlung Tranche 1 (100€ von 202.50€)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_charter, 'credit', '2026-05-15', 'Anzahlung Reservierung (Teilbetrag)', 100.00, p_clara, p_anna, tranche_1, p_anna, now());

  -- David: Selbstmeldung — confirmed_at = NULL (= pending)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_charter, 'credit', '2026-05-24', 'Anzahlung Reservierung (selbst gemeldet)', 202.50, p_david, p_anna, tranche_1, p_david, NULL);

  -- Eva: noch nichts → keine Transaktion

  -- ── Anna an die Charteragentur ───────────────────────────────────────
  -- Expense mit tranche_id = Tranche 1, paid_by = Anna. Bedeutet:
  -- Anna hat 600€ aus dem Anzahlungs-Pool an die Charteragentur überwiesen.
  -- Charter-Reminder-Banner zeigt damit: noch 450€ offen für Tranche 1.
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, tranche_id, created_by)
    VALUES (tx, trip_charter, 'expense', '2026-05-15', 'Überweisung Charteragentur Reservierung', 600.00, p_anna, c_yacht, 'equal', tranche_1, p_anna);
END $$;
