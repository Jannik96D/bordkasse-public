-- ═══════════════════════════════════════════════════════════════════════
-- 0047 — Tote Schreib-RLS-Policies droppen (Code-Review 2026-08, Fund 1)
--
-- Alle schreibenden Server Actions laufen über den Service-Role-Client
-- (lib/supabase/admin.ts) und prüfen Berechtigung im App-Layer — RLS wird
-- dort umgangen. Der EINZIGE Verwendungszweck des Cookie-/Browser-Clients
-- (lib/supabase/client.ts, ausschließlich in components/realtime-trip.tsx)
-- ist eine reine Realtime-SELECT-Subscription. Kein einziger Schreibpfad
-- der App nutzt den Cookie-Client — die folgenden "authenticated"-
-- Schreib-Policies aus 0004_rls.sql sind daher toter Code, der nur als
-- Angriffsfläche über die direkt ansprechbare PostgREST-Data-API existiert:
--
--   tm_update_skipper_or_self  — erlaubte jedem Crewmitglied, per PATCH auf
--     die eigene trip_members-Zeile `is_skipper=true` zu setzen (Selbst-
--     Beförderung zum Co-Skipper) sowie eigene on_board_from/to und
--     is_alcoholic frei zu manipulieren (Kostenanteil senken).
--   tm_insert_skipper / tm_delete_skipper — INSERT/DELETE auf trip_members
--     direkt über die Data-API, ohne die App-Guards aus
--     lib/actions/trip-members.ts (Owner-Schutz, Buchungs-Schutz, Audit).
--   tx_insert_member / tx_update_member / tx_delete_member — erlaubten
--     jedem Mitglied, Gutschriften direkt anzulegen (App: Skipper/Admin-
--     only), Beträge beliebiger Buchungen zu ändern, Buchungen PHYSISCH zu
--     löschen (App: nur Soft-Delete via deleted_at) — jeweils ohne
--     Audit-Log-Eintrag und ohne markPostSettlementChange.
--   tp_cud_member — dieselbe Lücke für transaction_participants. Die
--     SELECT-Policy tp_select_member bleibt unangetastet und deckt das
--     Lesen weiterhin ab (Buchungsliste bricht dadurch NICHT).
--
-- Realtime (ALTER PUBLICATION supabase_realtime aus 0004) ist unberührt —
-- Postgres-Changes-Subscriptions werden über SELECT-Policies gefiltert,
-- nicht über Schreib-Policies.
--
-- Regressionstest: supabase/tests/write_rls_lockdown_test.sql
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "tm_update_skipper_or_self" ON trip_members;
DROP POLICY IF EXISTS "tm_insert_skipper"         ON trip_members;
DROP POLICY IF EXISTS "tm_delete_skipper"         ON trip_members;

DROP POLICY IF EXISTS "tx_insert_member" ON transactions;
DROP POLICY IF EXISTS "tx_update_member" ON transactions;
DROP POLICY IF EXISTS "tx_delete_member" ON transactions;

DROP POLICY IF EXISTS "tp_cud_member" ON transaction_participants;
