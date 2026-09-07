-- ═══════════════════════════════════════════════════════════════════════
-- 0049 — Purge-Funktionen gegen anonymen Aufruf sperren (Sanierungsplan
-- 2026-09, PR 0, Fund 1)
--
-- PostgreSQL vergibt beim CREATE FUNCTION standardmäßig EXECUTE an PUBLIC —
-- das schließt die Rollen `anon` und `authenticated` ein, über die
-- PostgREST jede Function als `/rpc/<name>` erreichbar macht. Keine der
-- bisherigen Migrationen hat diesen impliziten Grant je zurückgenommen;
-- die spätere `GRANT ... TO service_role` (0011/0018/0019/0020) kommt
-- ZUSÄTZLICH zum PUBLIC-Grant, ersetzt ihn nicht.
--
-- Konkreter Angriff: mit dem öffentlichen anon-Key aus dem Browser-Bundle
-- und einer Törn-UUID aus der URL kann JEDER, ohne Login,
-- POST /rest/v1/rpc/purge_trip_data {"p_trip_id": "...", "p_force": true}
-- aufrufen. Einziges verbleibendes Gate ist `all_debts_settled`, das für
-- jeden Törn ohne offene Bordkasse-Schulden erfüllt ist — für einen frisch
-- angelegten oder abgeschlossenen Törn praktisch immer.
--
-- Betroffen: purge_trip_data, purge_expired_trip_data, all_debts_settled,
-- mark_post_settlement_change — alle vier sind reine Service-Role-Funktionen
-- (Cron bzw. der manuelle Admin-/Skipper-Button in lib/actions/trips.ts),
-- keine App-Code-Stelle ruft sie über den Cookie-/anon-Client auf.
--
-- NICHT anfassen: simplify_debts(uuid) (lib/queries/balances.ts liest sie
-- über den Cookie-Client) sowie is_trip_member/-skipper/current_person_id —
-- die laufen mit den Rechten des abfragenden Nutzers innerhalb von
-- Policy-Ausdrücken; ein REVOKE dort würde jeden Lesezugriff mit
-- "permission denied for function" beenden.
--
-- Rollback: GRANT EXECUTE ON FUNCTION <name> TO PUBLIC; (stellt den
-- Vorzustand wieder her, nicht empfohlen).
--
-- Regressionstest: supabase/tests/function_privileges_test.sql
-- ═══════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION purge_trip_data(uuid, boolean)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purge_expired_trip_data()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION all_debts_settled(uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mark_post_settlement_change(uuid)   FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION purge_trip_data(uuid, boolean)    TO service_role;
GRANT EXECUTE ON FUNCTION purge_expired_trip_data()         TO service_role;
GRANT EXECUTE ON FUNCTION all_debts_settled(uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION mark_post_settlement_change(uuid) TO service_role;
