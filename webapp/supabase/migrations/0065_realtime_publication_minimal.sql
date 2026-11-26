-- ═══════════════════════════════════════════════════════════════════════
-- 0065 — Realtime-Publikation auf das Nötige verkleinern
-- (Sicherheitsrunde 2026-11, Slice 14)
--
-- Befund: Supabase Realtime prüft RLS bei DELETE-Events nicht — der alte
-- Datensatz (Primärschlüssel) geht an jeden Abonnenten des Kanals. Bei
-- Tabellen mit zusammengesetztem Personen-Schlüssel (transaction_participants:
-- transaction_id+person_id, prepayment_obligations: trip_id+person_id, …)
-- ließ sich so eine Zuordnung Törn ↔ Personen-UUID mitschneiden.
-- Die App (components/realtime-trip.tsx) abonniert aber ausschließlich
-- transactions, trip_members und settled_debts — alles andere in der
-- Publikation war ungenutzt.
--
-- Fix: die fünf ungenutzten Tabellen aus supabase_realtime entfernen.
-- Idempotent (nur droppen, wenn enthalten), keine Datenänderung.
-- Bleiben: transactions, trip_members, settled_debts (siehe RealtimeTrip).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transaction_participants',
    'prepayment_plan',
    'prepayment_obligations',
    'prepayment_tranches',
    'cabin_types'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
