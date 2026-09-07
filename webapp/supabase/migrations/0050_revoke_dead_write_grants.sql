-- ═══════════════════════════════════════════════════════════════════════
-- 0050 — Tote Schreib-Rechte auf der Data-API entfernen (Sanierungsplan
-- 2026-09, PR 1, Funde 3/4/44)
--
-- ALLE schreibenden Server Actions dieser App laufen über den
-- Service-Role-Client (lib/supabase/admin.ts) — RLS und Tabellen-GRANTs
-- werden dort vollständig umgangen. Der Cookie-/Browser-Client
-- (lib/supabase/client.ts) wird ausschließlich für eine reine
-- Realtime-SELECT-Subscription genutzt (components/realtime-trip.tsx).
-- Kein einziger Schreibpfad nutzt `authenticated` oder `anon` über
-- PostgREST.
--
-- Trotzdem tragen `anon` UND `authenticated` bisher volle INSERT/UPDATE/
-- DELETE-Rechte auf ALLEN public-Tabellen:
--   - explizit für `authenticated` seit 0022_explicit_grants.sql (dort in
--     der Annahme geschrieben, RLS-Policies allein würden ausreichend
--     filtern — Fund 44 zeigt: eine neue Tabelle OHNE eigene RLS-Policy
--     ist damit ab der ersten Sekunde per PATCH/POST/DELETE über die
--     Data-API beschreibbar, auch für nicht besonders privilegierte
--     Mitglieder)
--   - für `anon` schon seit der Postgres-Cluster-Initialisierung des
--     selbst gehosteten Supabase-Stacks (pg_default_acl zeigt volle
--     arwdDxtm-Defaults für `postgres` UND `anon`/`authenticated` in
--     public — vermutlich Supabase-Boilerplate, nie bewusst gesetzt)
--
-- Migrationen laufen (lokal via `supabase db push`, produktiv identisch)
-- als Rolle `postgres` — das ist die Rolle, die alle public-Tabellen
-- besitzt (siehe pg_tables.tableowner) und deren Default-Privileges hier
-- gezielt zurückgenommen werden. `ALTER DEFAULT PRIVILEGES` ist rollen-
-- gebunden: ein Revoke ohne `FOR ROLE postgres` träfe die Defaults der
-- aufrufenden Rolle (hier ebenfalls `postgres`, aber explizit genannt,
-- damit die Bindung nicht implizit bleibt).
--
-- SELECT bleibt für `authenticated` erhalten (Crew-Lesepfad über RLS,
-- Realtime-Subscription). `anon` behält ebenfalls SELECT — die
-- SELECT-Policies (0004_rls.sql) sind ausschließlich `TO authenticated`
-- deklariert, ein anonymer Request scheitert also weiterhin an RLS, nicht
-- am GRANT; ein Revoke von SELECT für `anon` wäre daher wirkungslos, aber
-- potenziell riskant für künftige, bewusst öffentliche Tabellen.
--
-- Die anschließend gedroppten Policies waren nach 0047 bereits die
-- letzten verbliebenen Schreib-Policies für `authenticated` — nach dem
-- GRANT-Revoke oben sind sie wirkungslos (kein Schreib-Recht mehr, gegen
-- das sie filtern könnten), sollen aber nicht als fortbestehende Absicht
-- im Schema stehen bleiben.
--
-- Rollback:
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT INSERT, UPDATE, DELETE ON TABLES TO authenticated;
--   GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--     TO authenticated;
--   (die gedroppten Policies müssten aus 0004/0013/0023 wiederhergestellt
--   werden — nicht empfohlen, sie waren die eigentliche Schwachstelle)
--
-- Regressionstest: supabase/tests/write_rls_lockdown_test.sql (erweitert)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Defaults für künftige Tabellen ────────────────────────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;

-- ── 2. Bestehende Tabellen ────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;

-- ── 3. Tote Write-Policies droppen (nach dem Revoke wirkungslos) ────────
DROP POLICY IF EXISTS "persons_insert_self" ON persons;
DROP POLICY IF EXISTS "persons_update_self" ON persons;

DROP POLICY IF EXISTS "pp_update_self" ON persons_private;

DROP POLICY IF EXISTS "trips_insert_self"   ON trips;
DROP POLICY IF EXISTS "trips_update_skipper" ON trips;
DROP POLICY IF EXISTS "trips_delete_skipper" ON trips;

DROP POLICY IF EXISTS "tc_cud_skipper" ON trip_categories;

DROP POLICY IF EXISTS "pp_cud_skipper" ON prepayment_plan;
DROP POLICY IF EXISTS "ct_cud_skipper" ON cabin_types;
DROP POLICY IF EXISTS "po_cud_skipper" ON prepayment_obligations;
DROP POLICY IF EXISTS "tr_cud_skipper" ON prepayment_tranches;
