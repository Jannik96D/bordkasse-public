-- ═══════════════════════════════════════════════════════════════════════
-- seed_prepayments_test.sql — Lokales Test-Setup für das Anzahlungs-Modul
--
-- Erzeugt:
--   1. Auth-User skipper@example.com (Admin laut ADMIN_EMAILS-Env)
--   2. Skipper-Person „Jannik"
--   3. Crew (5 Personen): Lucas (mit E-Mail), Dario (Ghost), Tim (Ghost),
--      Emma (mit E-Mail), Stephan (mit E-Mail)
--   4. Trip „Ostsee-Törn Juli 2027" (10 Monate in der Zukunft, damit
--      Tranchen-Fälligkeiten sinnvoll sind)
--   5. Default-Kategorien
--
-- Anwendung: docker exec -i supabase_db_bordkasse psql -U postgres -d postgres \
--              < webapp/supabase/seed_prepayments_test.sql
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  skipper_auth UUID := '11111111-aaaa-bbbb-cccc-000000000001';
  p_jannik   UUID := 'dddddddd-0000-0000-0000-000000000001';
  p_lucas    UUID := 'dddddddd-0000-0000-0000-000000000002';
  p_dario    UUID := 'dddddddd-0000-0000-0000-000000000003';
  p_tim      UUID := 'dddddddd-0000-0000-0000-000000000004';
  p_emma     UUID := 'dddddddd-0000-0000-0000-000000000005';
  p_stephan  UUID := 'dddddddd-0000-0000-0000-000000000006';
  trip_test  UUID := 'eeeeeeee-0000-0000-0000-000000000001';
  c_yacht        UUID := 'ffffffff-0000-0000-0000-000000000001';
  c_lebensmittel UUID := 'ffffffff-0000-0000-0000-000000000002';
  c_sprit        UUID := 'ffffffff-0000-0000-0000-000000000003';
  c_hafen        UUID := 'ffffffff-0000-0000-0000-000000000004';
  c_restaurant   UUID := 'ffffffff-0000-0000-0000-000000000005';
  c_sonstiges    UUID := 'ffffffff-0000-0000-0000-000000000006';
BEGIN
  -- ── Aufräumen falls schon vorhanden ──────────────────────────────────
  DELETE FROM trips WHERE id = trip_test;
  DELETE FROM persons WHERE id IN (p_jannik, p_lucas, p_dario, p_tim, p_emma, p_stephan);
  DELETE FROM auth.users WHERE id = skipper_auth;

  -- ── Auth-User (Magic-Link-Login funktioniert sofort, kein Confirm nötig) ──
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    skipper_auth,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'skipper@example.com',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

  -- ── Personen ─────────────────────────────────────────────────────────
  INSERT INTO persons (id, auth_user_id, display_name, is_alcoholic) VALUES
    (p_jannik,  skipper_auth, 'Jannik',  TRUE),
    (p_lucas,   NULL,         'Lucas',   TRUE),
    (p_dario,   NULL,         'Dario',   TRUE),
    (p_tim,     NULL,         'Tim',     FALSE),
    (p_emma,    NULL,         'Emma',    FALSE),
    (p_stephan, NULL,         'Stephan', FALSE);

  -- Nur die mit E-Mail: Lucas, Emma, Stephan + Jannik selbst
  INSERT INTO persons_private (person_id, email) VALUES
    (p_jannik,  'skipper@example.com'),
    (p_lucas,   'lucas@example.com'),
    (p_emma,    'emma@example.com'),
    (p_stephan, 'stephan@example.com');
  -- Dario und Tim sind Ghost-Personen ohne E-Mail (für Crew-ohne-Mail-Test)

  -- ── Trip ─────────────────────────────────────────────────────────────
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id) VALUES
    (trip_test, 'Ostsee-Törn Juli 2027', '2027-07-10', '2027-07-17', 'Seezeit', p_jannik);

  -- ── Crew ─────────────────────────────────────────────────────────────
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to, is_skipper, note) VALUES
    (trip_test, p_jannik,  NULL, NULL, TRUE,  'Skipper'),
    (trip_test, p_lucas,   NULL, NULL, FALSE, NULL),
    (trip_test, p_dario,   NULL, NULL, FALSE, 'Ghost (keine E-Mail)'),
    (trip_test, p_tim,     NULL, NULL, FALSE, 'Ghost (keine E-Mail)'),
    (trip_test, p_emma,    '2027-07-13', NULL, FALSE, 'Kommt erst Mittwoch'),
    (trip_test, p_stephan, NULL, NULL, FALSE, NULL);

  -- ── Kategorien ───────────────────────────────────────────────────────
  INSERT INTO trip_categories (id, trip_id, name, icon, sort_order) VALUES
    (c_yacht,        trip_test, 'Yacht',        'Sailboat',     1),
    (c_lebensmittel, trip_test, 'Lebensmittel', 'ShoppingCart', 2),
    (c_sprit,        trip_test, 'Sprit',        'Fuel',         3),
    (c_hafen,        trip_test, 'Hafen',        'Anchor',       4),
    (c_restaurant,   trip_test, 'Restaurant',   'Utensils',     5),
    (c_sonstiges,    trip_test, 'Sonstiges',    'Package',      6);

  RAISE NOTICE 'Test-Seed angelegt. Login: skipper@example.com (lokal Mailpit). Trip-ID: %', trip_test;
END $$;
