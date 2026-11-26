-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0065 (Sicherheitsrunde 2026-11, Slice 14):
-- Die Publikation supabase_realtime enthält genau die Tabellen, die
-- components/realtime-trip.tsx abonniert. Realtime prüft RLS bei DELETE
-- nicht — jede weitere Tabelle würde Primärschlüssel (Personen-UUIDs) leaken.
-- Wer eine Tabelle abonnieren will, muss diesen Test BEWUSST anpassen.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(2);

SELECT set_eq(
  $$SELECT tablename::text FROM pg_publication_tables WHERE pubname = 'supabase_realtime'$$,
  ARRAY['transactions', 'trip_members', 'settled_debts'],
  'supabase_realtime enthält genau die von RealtimeTrip abonnierten Tabellen'
);

SELECT is(
  (SELECT count(*)::int FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND tablename IN ('transaction_participants','prepayment_plan',
                       'prepayment_obligations','prepayment_tranches','cabin_types')),
  0,
  'keine der fünf ungenutzten Tabellen ist (mehr) in der Publikation'
);

SELECT * FROM finish();
ROLLBACK;
