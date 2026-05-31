-- 0032_pin_search_path — search_path auf SECURITY-DEFINER-Funktionen festnageln
--
-- Sicherheits-Härtung (Supabase-Linter „Function Search Path Mutable"):
-- SECURITY-DEFINER-Funktionen laufen mit den Rechten des Owners. Ohne fest
-- gepinnten search_path könnte ein Angreifer über einen manipulierten
-- search_path (z. B. ein temp-Schema mit gleichnamigen Objekten) eine
-- unqualifizierte Referenz in der Funktion umlenken und so privilegierten
-- Code ausführen.
--
-- Fix: search_path = pg_catalog, public — explizit und unveränderlich. Die
-- Funktionen referenzieren nur public-Objekte (unqualifiziert) bzw. auth.*
-- (schema-qualifiziert, von search_path unbeeinflusst), daher reicht
-- pg_catalog + public; nichts bricht. Reiner Metadaten-ALTER, kein Body-
-- Rewrite → risikoarm, idempotent erneut anwendbar.

ALTER FUNCTION is_trip_member(uuid)            SET search_path = pg_catalog, public;
ALTER FUNCTION is_trip_skipper(uuid)           SET search_path = pg_catalog, public;
ALTER FUNCTION current_person_id()             SET search_path = pg_catalog, public;
ALTER FUNCTION purge_expired_trip_data()       SET search_path = pg_catalog, public;
ALTER FUNCTION purge_trip_data(uuid, boolean)  SET search_path = pg_catalog, public;
ALTER FUNCTION delete_my_account()             SET search_path = pg_catalog, public;

-- all_debts_settled ist SECURITY INVOKER (kein Privileg-Eskalations-Risiko),
-- wird aber zur Lint-Sauberkeit ebenfalls gepinnt.
ALTER FUNCTION all_debts_settled(uuid)         SET search_path = pg_catalog, public;
