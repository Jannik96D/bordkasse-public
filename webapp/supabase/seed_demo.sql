-- ═══════════════════════════════════════════════════════════════════════
-- seed_demo.sql — Demo-Daten für /about Screenshots
--
-- ⚠ ALLE DATEN WERDEN DYNAMISCH AUS DEM AKTUELLEN TAGESDATUM (CURRENT_DATE)
--   BERECHNET — Trip-Zeiträume, Buchungs-/Tranchen-/Zahlungs-Daten UND die
--   Jahreszahlen in den Törn-Namen. Dadurch passt der Demo-Stand bei JEDEM
--   Screenshot-Zyklus (jeder erneute Lauf von seed-demo.sh) automatisch zum
--   dann gültigen Datum — keine Drift, keine Inkonsistenz zwischen Name-Jahr
--   und Trip-Datum, kein verfrühter „überfällig"/„vorbei"-Zustand.
--   → NICHT durch feste Datumsliterale ('2026-06-…') ersetzen!
--
-- Drei Törns à 1 Woche, relativ zu „heute" (= CURRENT_DATE beim Seed-Lauf):
--   1. Ostseetörn {laufendes Jahr} — LÄUFT, klar mitten drin (heute-3 …
--      heute+3, heute = Tag-Mitte). Trägt die Buchungs-/Bilanz-/Schulden-/
--      Statistik-Demo. KEIN Settlement-Banner (Törn läuft noch — bewusst so).
--   2. Kroatien {Vorjahr} — VORBEI (1 Woche im September des Vorjahres),
--      vollständig abgerechnet & beglichen (settled_debts via simplify_debts).
--   3. Korsika {Folgejahr} — ANSTEHEND (1 Woche im Juni des Folgejahres),
--      Charter mit Anzahlungsplan (Kojen, Vorstrecker Anna, 2 Tranchen).
--      Tranche 1 fällig heute+10 → „bald fällig"-Indikator (kein overdue).
--      Lebendige Zahlungs-Stati: voll bezahlt / Teilzahlung / Pending-Selbst-
--      meldung.
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

-- ── Personen (geteilt über alle drei Törns) ──────────────────────────
DO $$
DECLARE
  p_anna   UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-4000-8000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-4000-8000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-4000-8000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-4000-8000-000000000005';
BEGIN
  -- Alten Test-Seed entfernen (Trip "Test-Törn April 2026")
  DELETE FROM trips WHERE id = '22222222-2222-4222-8222-000000000001';
  DELETE FROM persons WHERE id IN (
    '11111111-1111-4111-8111-000000000001',
    '11111111-1111-4111-8111-000000000002',
    '11111111-1111-4111-8111-000000000003',
    '11111111-1111-4111-8111-000000000004',
    '11111111-1111-4111-8111-000000000005',
    '11111111-1111-4111-8111-000000000006',
    '11111111-1111-4111-8111-000000000007',
    '11111111-1111-4111-8111-000000000008',
    '11111111-1111-4111-8111-000000000009',
    '11111111-1111-4111-8111-00000000000a'
  );

  -- Demo-Törns vorab löschen (idempotent, falls ohne db-reset eingespielt).
  -- Cascade räumt trip_members / transactions / prepayment_* mit weg.
  DELETE FROM trips WHERE id IN (
    'bbbbbbbb-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000003'
  );
  DELETE FROM persons WHERE id IN (p_anna, p_ben, p_clara, p_david, p_eva);

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
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- TÖRN 1: Ostseetörn {laufendes Jahr} — LÄUFT, klar mitten drin
-- Zeitraum heute-3 … heute+3 (heute = Tag-Mitte) → Status „Läuft", KEIN
-- Settlement-Banner (settlement_announced_at bleibt NULL, aber der Törn ist
-- noch nicht vorbei → kein Banner). Trägt die Buchungs-/Bilanz-/Schulden-/
-- Statistik-Demo. Eva steigt einen Tag vor heute zu (An-Bord-Demo).
-- Alle Datumsangaben relativ zu CURRENT_DATE — siehe Kopf-Kommentar.
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  p_anna   UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-4000-8000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-4000-8000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-4000-8000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-4000-8000-000000000005';

  trip_ostsee UUID := 'bbbbbbbb-0000-4000-8000-000000000001';

  -- Kategorien (lucide-Icon-Namen)
  c_lebensmittel UUID := 'cccccccc-0000-4000-8000-000000000001';
  c_restaurant   UUID := 'cccccccc-0000-4000-8000-000000000002';
  c_sprit        UUID := 'cccccccc-0000-4000-8000-000000000003';
  c_yacht        UUID := 'cccccccc-0000-4000-8000-000000000004';
  c_hafen        UUID := 'cccccccc-0000-4000-8000-000000000005';
  c_ausruestung  UUID := 'cccccccc-0000-4000-8000-000000000006';
  c_versicherung UUID := 'cccccccc-0000-4000-8000-000000000007';
  c_sonstiges    UUID := 'cccccccc-0000-4000-8000-000000000008';

  -- Dynamische Datumsbasis: heute = Tag-Mitte eines 1-Wochen-Törns
  today DATE := CURRENT_DATE;

  tx UUID;
BEGIN
  -- Ohne Anzahlungsplan unterwegs → explizit abgewählt (prepayment_declined_at),
  -- sonst zeigt die Törn-Fortschritt-Karte ein ewig offenes „Anzahlungsplan anlegen".
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id, prepayment_declined_at, foreign_currencies) VALUES
    (trip_ostsee, 'Ostseetörn ' || to_char(today, 'YYYY'), today - 3, today + 4, 'Sea Spirit', p_anna, now(), '{NOK,DKK}');

  -- ── Crew ─────────────────────────────────────────────────────────────
  -- Eva kommt erst einen Tag vor „heute" dazu, Rest den ganzen Törn → „An Bord"-Demo
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, note) VALUES
    (trip_ostsee, p_anna,  NULL,        NULL, 'Skipperin'),
    (trip_ostsee, p_ben,   NULL,        NULL, NULL),
    (trip_ostsee, p_clara, NULL,        NULL, NULL),
    (trip_ostsee, p_david, NULL,        NULL, NULL),
    (trip_ostsee, p_eva,   today - 1,   NULL, 'Steigt in Heiligenhafen zu');

  -- ── Kategorien (Default-Set, lucide-Icon-Namen) ──────────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (c_lebensmittel, trip_ostsee, 'Lebensmittel',       'ShoppingCart', 1),
    (c_restaurant,   trip_ostsee, 'Restaurant',         'Utensils',     2),
    (c_sprit,        trip_ostsee, 'Sprit',              'Fuel',         3),
    (c_yacht,        trip_ostsee, 'Yacht',              'Sailboat',     4),
    (c_hafen,        trip_ostsee, 'Hafen / Liegeplatz', 'Anchor',       5),
    (c_ausruestung,  trip_ostsee, 'Ausrüstung',         'Wrench',       6),
    (c_versicherung, trip_ostsee, 'Versicherung',       'ShieldCheck',  7),
    (c_sonstiges,    trip_ostsee, 'Sonstiges',          'Package',      8);

  -- ── Buchungen (alle Daten ≤ heute, da der Törn gerade läuft) ─────────
  -- 1. Lebensmittel Edeka — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 3, 'Edeka Großeinkauf', 78.40, p_anna, c_lebensmittel, 'equal', p_anna);

  -- 2. Restaurant Hafenkrug — an Bord, mit Alkohol (Eva noch nicht da)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 2, 'Hafenkrug Travemünde', 124.50, 30.00, p_ben, c_restaurant, 'on_board', p_anna);

  -- 3. Sprit Diesel — zeitanteilig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 1, 'Diesel Heiligenhafen', 86.20, p_anna, c_sprit, 'time_proportional', p_anna);

  -- 4. Marina-Liegegebühr — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 1, 'Marina Heiligenhafen', 45.00, p_clara, c_hafen, 'equal', p_anna);

  -- 5. Brötchen morgens — an Bord (Eva inzwischen dabei)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today, 'Bäcker Brötchen', 12.80, p_david, c_lebensmittel, 'on_board', p_anna);

  -- 6. Schwimmwesten — individuell (nur Ben + David)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 3, 'Schwimmwesten neu', 65.00, p_ben, c_ausruestung, 'individual', p_anna);
  INSERT INTO transaction_participants (transaction_id, person_id) VALUES
    (tx, p_ben), (tx, p_david);

  -- 7. Bier-Einkauf — Alkohol-Betrag = Gesamtbetrag (zahlen nur Trinker)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today - 2, 'Getränkemarkt', 38.50, 38.50, p_clara, c_lebensmittel, 'equal', p_anna);

  -- 8. Hafen Maasholm — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today, 'Hafen Maasholm', 28.00, p_anna, c_hafen, 'equal', p_anna);

  -- 9. Restaurant „Pro Person" — jeder zahlt seine eigene Bestellung
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_ostsee, 'expense', today, 'Strandrestaurant Maasholm', 88.90, p_anna, c_restaurant, 'per_person', p_anna);
  INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
    (tx, p_anna,  22.50),
    (tx, p_ben,   16.80),
    (tx, p_clara, 19.40),
    (tx, p_david, 14.20),
    (tx, p_eva,   16.00);

  -- ── Gutschrift ───────────────────────────────────────────────────────
  -- Anna hat 200€ Yachtvorauszahlung an die Crew geleistet
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, created_by)
    VALUES (tx, trip_ostsee, 'credit', today - 3, 'Yachtvorauszahlung', 200.00, p_anna, NULL, p_anna);
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- TÖRN 2: Kroatien {Vorjahr} — VORBEI (1 Woche im September des Vorjahres)
-- Vollständig abgerechnet: settlement_announced_at gesetzt + alle
-- simplify_debts als settled_debts markiert → zeigt den abgeschlossenen
-- „Abrechnung verschickt"-Zustand. (Liegt > 30 Tage zurück → die Törn-Liste
-- markiert ihn für Skipper/Admin als DSGVO-überfällig; im Screenshot 03
-- wird dieser Banner ausgeblendet.) Jahr + Daten dynamisch aus CURRENT_DATE.
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  p_anna   UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-4000-8000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-4000-8000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-4000-8000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-4000-8000-000000000005';

  trip_kroatien UUID := 'bbbbbbbb-0000-4000-8000-000000000003';

  -- Kategorien (lucide-Icon-Namen)
  ck_lebensmittel UUID := 'cccccccc-0000-4000-8000-000000000301';
  ck_restaurant   UUID := 'cccccccc-0000-4000-8000-000000000302';
  ck_sprit        UUID := 'cccccccc-0000-4000-8000-000000000303';
  ck_hafen        UUID := 'cccccccc-0000-4000-8000-000000000304';
  ck_yacht        UUID := 'cccccccc-0000-4000-8000-000000000305';
  ck_versicherung UUID := 'cccccccc-0000-4000-8000-000000000306';
  ck_sonstiges    UUID := 'cccccccc-0000-4000-8000-000000000307';

  -- Vorjahr (dynamisch). Törn-Woche im September des Vorjahres.
  ky    INT  := EXTRACT(YEAR FROM CURRENT_DATE)::int - 1;
  k_beg DATE := make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1, 9, 6);

  tx UUID;
BEGIN
  -- Vollständig abgeschlossener Törn ohne Anzahlung → ebenfalls abgewählt,
  -- damit die Checkliste „alles erledigt" zeigen kann.
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id, settlement_announced_at, prepayment_declined_at) VALUES
    (trip_kroatien, 'Kroatien ' || ky::text, k_beg, k_beg + 7, 'Bavaria 46', p_anna,
     make_timestamptz(ky, 9, 14, 18, 0, 0), make_timestamptz(ky, 9, 14, 18, 0, 0));

  -- ── Crew (alle den ganzen Törn) ──────────────────────────────────────
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, note) VALUES
    (trip_kroatien, p_anna,  NULL, NULL, 'Skipperin'),
    (trip_kroatien, p_ben,   NULL, NULL, NULL),
    (trip_kroatien, p_clara, NULL, NULL, NULL),
    (trip_kroatien, p_david, NULL, NULL, NULL),
    (trip_kroatien, p_eva,   NULL, NULL, NULL);

  -- ── Kategorien (Default-Set, lucide-Icon-Namen) ──────────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (ck_lebensmittel, trip_kroatien, 'Lebensmittel',       'ShoppingCart', 1),
    (ck_restaurant,   trip_kroatien, 'Restaurant',         'Utensils',     2),
    (ck_sprit,        trip_kroatien, 'Sprit',              'Fuel',         3),
    (ck_hafen,        trip_kroatien, 'Hafen / Liegeplatz', 'Anchor',       4),
    (ck_yacht,        trip_kroatien, 'Yacht',              'Sailboat',     5),
    (ck_versicherung, trip_kroatien, 'Versicherung',       'ShieldCheck',  6),
    (ck_sonstiges,    trip_kroatien, 'Sonstiges',          'Package',      7);

  -- ── Buchungen (Kroatien-Törn, Daten in der Törn-Woche) ───────────────
  -- 1. Großeinkauf — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg, 'Konzum Großeinkauf', 92.00, p_anna, ck_lebensmittel, 'equal', p_anna);

  -- 2. Konoba — an Bord, mit Alkohol
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg + 1, 'Konoba Trogir', 156.00, 40.00, p_ben, ck_restaurant, 'on_board', p_anna);

  -- 3. Diesel — zeitanteilig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg + 2, 'Diesel Marina Kaštela', 110.00, p_anna, ck_sprit, 'time_proportional', p_anna);

  -- 4. Liegeplatz — gleichmäßig
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg + 3, 'Liegeplatz ACI Split', 68.00, p_clara, ck_hafen, 'equal', p_anna);

  -- 5. Getränke — Alkohol-Betrag = Gesamtbetrag (zahlen nur Trinker)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, alcohol_amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg + 4, 'Getränke Tommy', 44.00, 44.00, p_david, ck_lebensmittel, 'equal', p_anna);

  -- 6. Konoba „Pro Person" — jeder zahlt seine eigene Bestellung
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, created_by)
    VALUES (tx, trip_kroatien, 'expense', k_beg + 5, 'Konoba Hvar', 134.00, p_anna, ck_restaurant, 'per_person', p_anna);
  INSERT INTO transaction_participants (transaction_id, person_id, amount) VALUES
    (tx, p_anna,  30.00),
    (tx, p_ben,   24.00),
    (tx, p_clara, 28.00),
    (tx, p_david, 22.00),
    (tx, p_eva,   30.00);

  -- ── Gutschrift ───────────────────────────────────────────────────────
  -- Anna hat 250€ Yachtvorauszahlung an die Crew geleistet
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, created_by)
    VALUES (tx, trip_kroatien, 'credit', k_beg, 'Yachtvorauszahlung', 250.00, p_anna, NULL, p_anna);

  -- ── Abrechnung beglichen ─────────────────────────────────────────────
  -- Alle vereinfachten Schulden als bezahlt markieren (exakte Beträge
  -- direkt aus simplify_debts → Unique-Key passt garantiert).
  INSERT INTO settled_debts (trip_id, from_person_id, to_person_id, amount, settled_by_person_id, settled_at)
  SELECT trip_kroatien, sd.from_person_id, sd.to_person_id, sd.amount, p_anna, make_timestamptz(ky, 9, 15, 9, 0, 0)
  FROM simplify_debts(trip_kroatien) sd;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- TÖRN 3: Korsika {Folgejahr} — ANSTEHEND (1 Woche im Juni des Folgejahres)
-- Charter mit Anzahlungs-Plan (Kojen-Aufteilung, Vorstrecker Anna, 2 Tranchen).
-- Tranche 1 fällig heute+10 → „bald fällig"-Indikator, kein overdue. Lebendige
-- Zahlungs-Stati: voll bezahlt / Teilzahlung / Pending-Selbstmeldung.
-- Liefert die Daten für die /about Screenshots zum Anzahlungs-Modul.
-- Jahr + alle Daten dynamisch aus CURRENT_DATE.
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  p_anna   UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
  p_ben    UUID := 'aaaaaaaa-0000-4000-8000-000000000002';
  p_clara  UUID := 'aaaaaaaa-0000-4000-8000-000000000003';
  p_david  UUID := 'aaaaaaaa-0000-4000-8000-000000000004';
  p_eva    UUID := 'aaaaaaaa-0000-4000-8000-000000000005';

  trip_korsika UUID := 'bbbbbbbb-0000-4000-8000-000000000002';

  -- Kategorien (lucide-Icon-Namen)
  c_yacht        UUID := 'cccccccc-0000-4000-8000-000000000101';
  c_lebensmittel UUID := 'cccccccc-0000-4000-8000-000000000102';
  c_sprit        UUID := 'cccccccc-0000-4000-8000-000000000103';
  c_hafen        UUID := 'cccccccc-0000-4000-8000-000000000104';
  c_versicherung UUID := 'cccccccc-0000-4000-8000-000000000105';

  -- Anzahlungs-Module
  cabin_doppel UUID := 'dddddddd-0000-4000-8000-000000000201';
  cabin_einzel UUID := 'dddddddd-0000-4000-8000-000000000202';
  tranche_1    UUID := 'eeeeeeee-0000-4000-8000-000000000201';
  tranche_2    UUID := 'eeeeeeee-0000-4000-8000-000000000202';

  -- Folgejahr (dynamisch). Törn-Woche im Juni des Folgejahres.
  today  DATE := CURRENT_DATE;
  cy     INT  := EXTRACT(YEAR FROM CURRENT_DATE)::int + 1;
  k_beg  DATE := make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, 6, 5);
  t1_due DATE := CURRENT_DATE + 10;                                   -- „bald fällig"
  t2_due DATE := make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, 4, 15);  -- Endzahlung

  tx UUID;
BEGIN
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id) VALUES
    (trip_korsika, 'Korsika ' || cy::text, k_beg, k_beg + 7, 'Sun Odyssey 449', p_anna);

  -- ── Crew (alle den ganzen Törn) ──────────────────────────────────────
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, note) VALUES
    (trip_korsika, p_anna,  NULL, NULL, 'Skipperin · Vorstrecker'),
    (trip_korsika, p_ben,   NULL, NULL, NULL),
    (trip_korsika, p_clara, NULL, NULL, NULL),
    (trip_korsika, p_david, NULL, NULL, NULL),
    (trip_korsika, p_eva,   NULL, NULL, NULL);

  -- ── Kategorien (Default-Set mit lucide-Icon-Namen) ───────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (c_yacht,        trip_korsika, 'Yacht',         'Sailboat',     1),
    (c_lebensmittel, trip_korsika, 'Lebensmittel',  'ShoppingCart', 2),
    (c_sprit,        trip_korsika, 'Sprit',         'Fuel',         3),
    (c_hafen,        trip_korsika, 'Hafen',         'Anchor',       4),
    (c_versicherung, trip_korsika, 'Versicherung',  'ShieldCheck',  5);

  -- ── Anzahlungs-Plan: 3500€ Yacht, Kojen-Aufteilung ───────────────────
  INSERT INTO prepayment_plan (trip_id, split_method, total_amount, advancer_person_id, wero_id) VALUES
    (trip_korsika, 'kojen', 3500.00, p_anna, 'anna.h');

  -- ── Kojen ────────────────────────────────────────────────────────────
  -- Anna in der Kapitänskabine 800€, andere vier paarweise in Doppelkoje 675€/Person.
  -- Doppelkoje capacity = 4 (zwei Bettpaare im selben Kabinen-Typ —
  -- die Wizard-Validierung prüft Belegung gegen Plätze, nicht gegen
  -- physische Kabinen). Sonst gäbe es bei 4 Doppelkojen-Personen einen
  -- „Überbelegung!"-Fehler im Wizard-Step 1.
  INSERT INTO cabin_types (id, trip_id, label, price_per_person, capacity, sort_order) VALUES
    (cabin_einzel, trip_korsika, 'Kapitänskabine', 800.00, 1, 1),
    (cabin_doppel, trip_korsika, 'Doppelkoje',     675.00, 4, 2);

  -- ── Obligations (Soll pro Person) ────────────────────────────────────
  INSERT INTO prepayment_obligations (trip_id, person_id, cabin_type_id, total_amount) VALUES
    (trip_korsika, p_anna,  cabin_einzel, 800.00),
    (trip_korsika, p_ben,   cabin_doppel, 675.00),
    (trip_korsika, p_clara, cabin_doppel, 675.00),
    (trip_korsika, p_david, cabin_doppel, 675.00),
    (trip_korsika, p_eva,   cabin_doppel, 675.00);

  -- ── Tranchen (30% Reservierung bald fällig, 70% Endzahlung) ──────────
  -- t1_due = heute+10 → Banner zeigt „in 10 Tagen fällig" (soon-Indikator),
  -- kein overdue. t2_due = April des Törn-Jahres (Endzahlung).
  INSERT INTO prepayment_tranches (id, trip_id, due_date, label, percent, sort_order) VALUES
    (tranche_1, trip_korsika, t1_due, '1. Anzahlung', 30, 1),
    (tranche_2, trip_korsika, t2_due, 'Endzahlung',   70, 2);

  -- ── Crew-Zahlungen an Anna (Vorstrecker), Daten kurz vor heute ───────
  -- Anna: Selbst-Credit (bilanzneutral, Migration 0024 erlaubt das bei
  -- tranche-getaggten Buchungen) — sie hat ihren Anteil „bei sich selbst".
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_korsika, 'credit', today - 6, 'Anzahlung Reservierung (Selbst)', 240.00, p_anna, p_anna, tranche_1, p_anna, now());

  -- Ben: Tranche 1 voll bezahlt (202.50€)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_korsika, 'credit', today - 5, 'Anzahlung Reservierung', 202.50, p_ben, p_anna, tranche_1, p_anna, now());

  -- Clara: Tranche 1 voll bezahlt (202.50€)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_korsika, 'credit', today - 4, 'Anzahlung Reservierung', 202.50, p_clara, p_anna, tranche_1, p_anna, now());

  -- David: Selbstmeldung — confirmed_at = NULL (= pending)
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_korsika, 'credit', today - 1, 'Anzahlung Reservierung (selbst gemeldet)', 202.50, p_david, p_anna, tranche_1, p_david, NULL);

  -- Eva: Teilzahlung 80€ (von 202.50€) — zeigt den ◐-Status in der Matrix
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, credit_from, credit_to, tranche_id, created_by, confirmed_at)
    VALUES (tx, trip_korsika, 'credit', today - 3, 'Anzahlung Reservierung (Teilbetrag)', 80.00, p_eva, p_anna, tranche_1, p_anna, now());

  -- ── Anna an die Charteragentur ───────────────────────────────────────
  -- Expense mit tranche_id = Tranche 1, paid_by = Anna. Bedeutet:
  -- Anna hat 600€ aus dem Anzahlungs-Pool an die Charteragentur überwiesen.
  -- Charter-Reminder-Banner zeigt damit: noch 450€ offen für Tranche 1.
  tx := gen_random_uuid();
  INSERT INTO transactions (id, trip_id, type, date, description, amount, paid_by, category_id, split_type, tranche_id, created_by)
    VALUES (tx, trip_korsika, 'expense', today - 4, 'Überweisung Charteragentur Reservierung', 600.00, p_anna, c_yacht, 'equal', tranche_1, p_anna);
END $$;
