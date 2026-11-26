-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Migration 0064: Buchungs-Kategorie nur aus demselben Törn.
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════
BEGIN;
SELECT plan(8);

INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('64640000-0000-4000-8000-000000000001', 'Kat Skipper', NULL);

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('64640000-0000-4000-8000-0000000000aa', 'pgTAP Kat A', '2099-04-01', '2099-04-10', '64640000-0000-4000-8000-000000000001'),
  ('64640000-0000-4000-8000-0000000000bb', 'pgTAP Kat B', '2099-04-01', '2099-04-10', '64640000-0000-4000-8000-000000000001');

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('64640000-0000-4000-8000-0000000000aa', '64640000-0000-4000-8000-000000000001'),
  ('64640000-0000-4000-8000-0000000000bb', '64640000-0000-4000-8000-000000000001');

INSERT INTO trip_categories(id, trip_id, name, icon, sort_order) VALUES
  ('64640000-0000-4000-8000-0000000000c1', '64640000-0000-4000-8000-0000000000aa', 'Eigene', 'Tag', 1),
  ('64640000-0000-4000-8000-0000000000c2', '64640000-0000-4000-8000-0000000000bb', 'Fremde', 'Tag', 1);

SELECT is(
  (SELECT count(*)::int FROM pg_constraint
   WHERE conrelid = 'transactions'::regclass AND confrelid = 'trip_categories'::regclass
     AND contype = 'f' AND array_length(conkey, 1) = 1),
  0, 'kein einfacher FK auf trip_categories mehr');

SELECT lives_ok($$
  INSERT INTO transactions(id, trip_id, type, date, description, paid_by, amount, split_type, category_id)
  VALUES ('64640000-0000-4000-8000-0000000000e1', '64640000-0000-4000-8000-0000000000aa', 'expense',
          '2099-04-02', 'eigene Kategorie', '64640000-0000-4000-8000-000000000001', 10, 'equal',
          '64640000-0000-4000-8000-0000000000c1')
$$, 'eigene Kategorie wird akzeptiert');

SELECT lives_ok($$
  INSERT INTO transactions(id, trip_id, type, date, description, paid_by, amount, split_type, category_id)
  VALUES ('64640000-0000-4000-8000-0000000000e2', '64640000-0000-4000-8000-0000000000aa', 'expense',
          '2099-04-02', 'ohne Kategorie', '64640000-0000-4000-8000-000000000001', 10, 'equal', NULL)
$$, 'Buchung ohne Kategorie wird akzeptiert');

SELECT throws_ok($$
  INSERT INTO transactions(id, trip_id, type, date, description, paid_by, amount, split_type, category_id)
  VALUES ('64640000-0000-4000-8000-0000000000e3', '64640000-0000-4000-8000-0000000000aa', 'expense',
          '2099-04-02', 'fremde Kategorie', '64640000-0000-4000-8000-000000000001', 10, 'equal',
          '64640000-0000-4000-8000-0000000000c2')
$$, '23503', NULL, 'Fremd-Kategorie beim INSERT wird abgewiesen');

SELECT throws_ok($$
  UPDATE transactions SET category_id = '64640000-0000-4000-8000-0000000000c2'
  WHERE id = '64640000-0000-4000-8000-0000000000e1'
$$, '23503', NULL, 'Fremd-Kategorie beim UPDATE wird abgewiesen');

-- Soft-gelöschte Zeilen werden mitgeprüft
SELECT throws_ok($$
  INSERT INTO transactions(id, trip_id, type, date, description, paid_by, amount, split_type, category_id, deleted_at)
  VALUES ('64640000-0000-4000-8000-0000000000e4', '64640000-0000-4000-8000-0000000000aa', 'expense',
          '2099-04-02', 'soft-gelöscht fremd', '64640000-0000-4000-8000-000000000001', 10, 'equal',
          '64640000-0000-4000-8000-0000000000c2', now())
$$, '23503', NULL, 'auch soft-gelöschte Buchungen mit Fremd-Kategorie werden abgewiesen');

-- Kategorie löschen nullt NUR category_id, nicht trip_id
DELETE FROM trip_categories WHERE id = '64640000-0000-4000-8000-0000000000c1';
SELECT is(
  (SELECT category_id FROM transactions WHERE id = '64640000-0000-4000-8000-0000000000e1'),
  NULL::uuid, 'Kategorie löschen nullt category_id');
SELECT is(
  (SELECT trip_id FROM transactions WHERE id = '64640000-0000-4000-8000-0000000000e1'),
  '64640000-0000-4000-8000-0000000000aa'::uuid, 'trip_id bleibt beim Löschen der Kategorie erhalten');

SELECT * FROM finish();
ROLLBACK;
