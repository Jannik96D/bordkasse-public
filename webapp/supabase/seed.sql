-- ═══════════════════════════════════════════════════════════════════════
-- seed.sql — Test-Szenarien S1–S7 aus docs/calculation-rules.md
--
-- Setup:
--   • 10 Personen Crew (Jannik, Lucas, Dario, Mama, Papa, Stephan, Peter,
--     Harald, Tia, Ida)
--   • Törn 5.–15. April 2026 (11 Tage)
--   • Stephan kommt ab 10.04. (6 Tage)
--   • Trinker: Dario, Mama, Papa
--
-- Wird via `supabase db reset` automatisch eingespielt (zusammen mit den
-- Migrations).
-- ═══════════════════════════════════════════════════════════════════════

-- Eindeutige IDs als Konstanten — erlaubt deterministische Tests.
DO $$
DECLARE
  -- Personen
  p_jannik  UUID := '11111111-1111-1111-1111-000000000001';
  p_lucas   UUID := '11111111-1111-1111-1111-000000000002';
  p_dario   UUID := '11111111-1111-1111-1111-000000000003';
  p_mama    UUID := '11111111-1111-1111-1111-000000000004';
  p_papa    UUID := '11111111-1111-1111-1111-000000000005';
  p_stephan UUID := '11111111-1111-1111-1111-000000000006';
  p_peter   UUID := '11111111-1111-1111-1111-000000000007';
  p_harald  UUID := '11111111-1111-1111-1111-000000000008';
  p_tia     UUID := '11111111-1111-1111-1111-000000000009';
  p_ida     UUID := '11111111-1111-1111-1111-00000000000a';

  -- Trip
  trip_test UUID := '22222222-2222-2222-2222-000000000001';

  -- Kategorien
  cat_lebensmittel UUID := '33333333-3333-3333-3333-000000000001';
  cat_restaurant   UUID := '33333333-3333-3333-3333-000000000002';
  cat_sprit        UUID := '33333333-3333-3333-3333-000000000003';
  cat_yacht        UUID := '33333333-3333-3333-3333-000000000004';
  cat_ausruestung  UUID := '33333333-3333-3333-3333-000000000005';
BEGIN
  -- ── Personen ─────────────────────────────────────────────────────────
  INSERT INTO persons (id, display_name, email, is_alcoholic) VALUES
    (p_jannik,  'Jannik',  'jannik@example.test',  FALSE),
    (p_lucas,   'Lucas',   'lucas@example.test',   FALSE),
    (p_dario,   'Dario',   'dario@example.test',   TRUE),
    (p_mama,    'Mama',    NULL,                   TRUE),
    (p_papa,    'Papa',    NULL,                   TRUE),
    (p_stephan, 'Stephan', 'stephan@example.test', FALSE),
    (p_peter,   'Peter',   NULL,                   FALSE),
    (p_harald,  'Harald',  NULL,                   FALSE),
    (p_tia,     'Tia',     NULL,                   FALSE),
    (p_ida,     'Ida',     NULL,                   FALSE);

  -- ── Trip ─────────────────────────────────────────────────────────────
  INSERT INTO trips (id, name, start_date, end_date, ship_name, skipper_id) VALUES
    (trip_test, 'Test-Törn April 2026', '2026-04-05', '2026-04-15', 'Test-Yacht', p_jannik);

  -- ── Crew ─────────────────────────────────────────────────────────────
  -- Stephan kommt erst am 10.04., alle anderen den ganzen Törn
  INSERT INTO trip_members (trip_id, person_id, on_board_from, on_board_to) VALUES
    (trip_test, p_jannik,  NULL, NULL),
    (trip_test, p_lucas,   NULL, NULL),
    (trip_test, p_dario,   NULL, NULL),
    (trip_test, p_mama,    NULL, NULL),
    (trip_test, p_papa,    NULL, NULL),
    (trip_test, p_stephan, '2026-04-10', NULL),
    (trip_test, p_peter,   NULL, NULL),
    (trip_test, p_harald,  NULL, NULL),
    (trip_test, p_tia,     NULL, NULL),
    (trip_test, p_ida,     NULL, NULL);

  -- ── Kategorien ───────────────────────────────────────────────────────
  INSERT INTO trip_categories (id, trip_id, name, sort_order) VALUES
    (cat_lebensmittel, trip_test, 'Lebensmittel',       1),
    (cat_restaurant,   trip_test, 'Restaurant',         2),
    (cat_sprit,        trip_test, 'Sprit',              3),
    (cat_yacht,        trip_test, 'Yacht',              4),
    (cat_ausruestung,  trip_test, 'Ausrüstung',         5);

  -- Hinweis: Test-Transaktionen werden NICHT hier eingespielt, damit
  -- man sie via Vitest oder manuell durchklickt. Für SQL-Smoke-Tests
  -- lassen sich die S1-S7-Inserts aus docs/calculation-rules.md direkt
  -- in psql/Studio einkippen.
END $$;
