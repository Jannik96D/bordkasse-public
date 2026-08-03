-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0044 (+ 0046): purge_trip_data behält
-- Buchungs-Kerndaten (Betrag/Beschreibung/Alkohol-Anteil/credit_to_all),
-- entfernt aber jeden Personenbezug (paid_by/credit_from/credit_to/
-- created_by, transaction_participants). Zusätzlich müssen die neuen
-- Audience-RLS-Policies auf transactions/trip_categories greifen: ein
-- Ex-Mitglied mit Login sieht die anonymisierten Buchungen weiterhin, ein
-- eingeloggter Fremder (kein Audience-Eintrag für DIESEN Törn) NICHT.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(11);

-- ── Setup: Zwei-Personen-Törn. P1 hat einen Login (auth_user_id), landet
-- also über die Audience-Spur im Purge. "Fremder" hat ebenfalls einen
-- Login, aber KEINE Mitgliedschaft/Audience-Spur zu diesem Törn — er dient
-- dem negativen RLS-Test (analog view_security_invoker_test.sql).
INSERT INTO persons(id, display_name, auth_user_id) VALUES
  ('44440000-0000-4000-8000-000000000001', 'Purge P1', '44440000-0000-4000-8000-0000000000f1'),
  ('44440000-0000-4000-8000-000000000002', 'Purge P2', NULL),
  ('44440000-0000-4000-8000-000000000003', 'Purge Fremder', '44440000-0000-4000-8000-0000000000f3');

INSERT INTO trips(id, name, start_date, end_date, skipper_id, settlement_announced_at) VALUES
  ('44440000-0000-4000-8000-0000000000aa', 'pgTAP Purge-Facts',
   '2020-01-01', '2020-01-10',
   '44440000-0000-4000-8000-000000000001', now());

INSERT INTO trip_categories(id, trip_id, name, icon, sort_order) VALUES
  ('44440000-0000-4000-8000-0000000000c1', '44440000-0000-4000-8000-0000000000aa',
   'Lebensmittel', 'ShoppingCart', 1);

INSERT INTO trip_members(trip_id, person_id) VALUES
  ('44440000-0000-4000-8000-0000000000aa', '44440000-0000-4000-8000-000000000001'),
  ('44440000-0000-4000-8000-0000000000aa', '44440000-0000-4000-8000-000000000002');

-- Ausgabe: P1 zahlt 30€ (11€ Alkohol), Aufteilung "equal" über beide.
INSERT INTO transactions(
  id, trip_id, type, date, description, amount, alcohol_amount,
  paid_by, created_by, category_id, split_type
) VALUES (
  '44440000-0000-4000-8000-0000000000e1', '44440000-0000-4000-8000-0000000000aa',
  'expense', '2020-01-02', 'Bier + Chips', 30, 12,
  '44440000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000001',
  '44440000-0000-4000-8000-0000000000c1', 'equal'
);
INSERT INTO transaction_participants(transaction_id, person_id, share)
  SELECT '44440000-0000-4000-8000-0000000000e1', person_id, 15
    FROM trip_members WHERE trip_id = '44440000-0000-4000-8000-0000000000aa';

-- DIREKTE Gutschrift P1 → P2 (KEIN "An Alle") — der eigentliche Bug-Trigger:
-- credit_to wird beim Purge genullt, credit_to_all muss trotzdem FALSE
-- bleiben, sonst zeigt die UI hinterher fälschlich "An Alle" an.
INSERT INTO transactions(
  id, trip_id, type, date, description, amount,
  credit_from, credit_to, credit_to_all, created_by
) VALUES (
  '44440000-0000-4000-8000-0000000000e2', '44440000-0000-4000-8000-0000000000aa',
  'credit', '2020-01-03', 'Direkte Rückzahlung', 15,
  '44440000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000002', FALSE,
  '44440000-0000-4000-8000-000000000001'
);

-- Resultierende Schuld (P2 schuldet P1 15€ aus der direkten Gutschrift;
-- die Ausgabe ist durch die 1:1-Teilung bereits ausgeglichen) als beglichen
-- markieren, damit all_debts_settled true ist.
INSERT INTO settled_debts(trip_id, from_person_id, to_person_id, amount)
VALUES ('44440000-0000-4000-8000-0000000000aa',
        '44440000-0000-4000-8000-000000000002', '44440000-0000-4000-8000-000000000001', 15);

-- ── Purge ausführen (force=true, um die 30-Tage/Settlement-Gates zu
-- überspringen — Törn liegt hier ohnehin schon in der Vergangenheit) ──
SELECT is(purge_trip_data('44440000-0000-4000-8000-0000000000aa', TRUE), 'ok',
  'purge_trip_data läuft ohne Fehler durch');

-- ── 1. Buchungs-Kerndaten bleiben erhalten ────────────────────────────
SELECT is(
  (SELECT amount FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e1'),
  30::numeric, 'Betrag bleibt erhalten');
SELECT is(
  (SELECT description FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e1'),
  'Bier + Chips', 'Beschreibung bleibt erhalten');
SELECT is(
  (SELECT alcohol_amount FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e1'),
  12::numeric, 'Alkohol-Anteil bleibt erhalten');
SELECT ok(
  (SELECT category_id FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e1') IS NOT NULL,
  'Kategorie-Zuordnung bleibt erhalten (trip_categories nicht gelöscht)');

-- ── 2. Personenbezug ist weg ──────────────────────────────────────────
SELECT ok(
  (SELECT paid_by IS NULL AND created_by IS NULL
     FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e1'),
  'paid_by/created_by sind genullt');
SELECT is(
  (SELECT count(*) FROM transaction_participants
    WHERE transaction_id = '44440000-0000-4000-8000-0000000000e1'),
  0::bigint, 'transaction_participants ist geleert');

-- ── 3. credit_to_all bleibt korrekt (Regression: direkte Gutschrift darf
-- nach der Anonymisierung NICHT als "An Alle" fehlinterpretierbar sein) ──
SELECT ok(
  (SELECT credit_to IS NULL AND credit_from IS NULL
     FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e2'),
  'credit_from/credit_to der direkten Gutschrift sind genullt');
SELECT is(
  (SELECT credit_to_all FROM transactions WHERE id = '44440000-0000-4000-8000-0000000000e2'),
  FALSE, 'credit_to_all bleibt FALSE — bleibt von "An Alle" unterscheidbar');

-- ── 4. RLS: Audience-Mitglied sieht die Buchungen weiterhin ───────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '44440000-0000-4000-8000-0000000000f1')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM transactions WHERE trip_id = '44440000-0000-4000-8000-0000000000aa'),
  2::bigint, 'Audience-Mitglied sieht beide anonymisierten Buchungen per RLS');
RESET ROLE;

-- ── 5. RLS: ein eingeloggter Fremder OHNE Audience-Spur sieht NICHTS ──
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '44440000-0000-4000-8000-0000000000f3')::text, TRUE);
SELECT is(
  (SELECT count(*) FROM transactions WHERE trip_id = '44440000-0000-4000-8000-0000000000aa'),
  0::bigint, 'Eingeloggter Fremder ohne Audience-Spur sieht 0 Zeilen');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
