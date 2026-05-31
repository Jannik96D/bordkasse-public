-- ═══════════════════════════════════════════════════════════════════════
-- 0035_view_security_invoker — RLS auch über Views erzwingen (S-1, KRITISCH)
--
-- Problem: Postgres-Views laufen standardmäßig mit den Rechten ihres
-- OWNERS (Definer-Semantik). Owner unserer Views ist die Migrations-Rolle
-- mit BYPASSRLS. Folge: ein SELECT über eine View umgeht die Row-Level-
-- Security der Basistabellen komplett. Der `anon`-Key (steckt als
-- NEXT_PUBLIC_SUPABASE_ANON_KEY in jedem Browser-Bundle) konnte so über
-- die öffentliche REST-API Finanzdaten ALLER Törns lesen:
--
--   SET ROLE anon;
--   SELECT count(*) FROM transactions;  -- 0   (RLS greift)
--   SELECT count(*) FROM v_balances;     -- 10  (View umging RLS)
--
-- Fix: alle 6 Views auf `security_invoker = on` stellen. Damit wird beim
-- Lesen die RLS der Basistabellen mit den Rechten des AUFRUFENDEN Users
-- erzwungen — anon und fremde authenticated bekommen 0 Zeilen.
--
-- Auswirkung auf die App: KEINE Regression.
--   • Crew liest über den Cookie-Client (Rolle `authenticated`) → die
--     bestehenden RLS-Policies aus 0004/0023 geben Mitgliedern genau ihre
--     Törn-Zeilen frei.
--   • Globale Admins + alle Schreib-/Cron-/Mail-Pfade lesen über den
--     Service-Role-Client → bypasst RLS weiterhin.
--   • `simplify_debts()` (SECURITY DEFINER) liest v_balances unter der
--     Definer-Rolle → sieht weiterhin alle Zeilen, bleibt funktional.
--
-- Zusätzlich: SELECT-Recht der `anon`-Rolle auf die Views entziehen. Der
-- anon-Key braucht diese Views nie (alle App-Reads laufen als
-- `authenticated` oder service_role). Defense-in-depth zum invoker-Flag.
--
-- Idempotent: ALTER VIEW … SET ist wiederholbar; REVOKE ebenso.
-- ═══════════════════════════════════════════════════════════════════════

ALTER VIEW v_balances                 SET (security_invoker = on);
ALTER VIEW v_transaction_shares       SET (security_invoker = on);
ALTER VIEW v_balances_bordkasse_only  SET (security_invoker = on);
ALTER VIEW v_prepayment_payments      SET (security_invoker = on);
ALTER VIEW v_prepayment_pending       SET (security_invoker = on);
ALTER VIEW v_trip_members_with_days   SET (security_invoker = on);

REVOKE SELECT ON v_balances                FROM anon;
REVOKE SELECT ON v_transaction_shares      FROM anon;
REVOKE SELECT ON v_balances_bordkasse_only FROM anon;
REVOKE SELECT ON v_prepayment_payments     FROM anon;
REVOKE SELECT ON v_prepayment_pending      FROM anon;
REVOKE SELECT ON v_trip_members_with_days  FROM anon;
