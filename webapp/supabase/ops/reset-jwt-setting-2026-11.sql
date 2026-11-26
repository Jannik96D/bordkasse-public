-- ═══════════════════════════════════════════════════════════════════════
-- JWT-Secret als Datenbankeinstellung entfernen (Sicherheitsrunde 2026-11,
-- Slice 18) — EINMALIG je bestehender Installation.
--
-- `volumes/db/jwt.sql` hat bei der Erstinitialisierung
-- `ALTER DATABASE postgres SET "app.settings.jwt_secret"` gesetzt. Die
-- Einstellung ist per `current_setting('app.settings.jwt_secret')` für JEDE
-- Rolle lesbar (auch anon). Nichts in der Datenbank liest sie (pgTAP
-- `db_hardening_test.sql`); PostgREST prüft Tokens über PGRST_JWT_SECRET,
-- Realtime über API_JWT_SECRET, GoTrue über GOTRUE_JWT_SECRET (alle Env).
--
-- Warum kein Migrationsschritt: die Einstellung hat supabase_admin
-- (Superuser) gesetzt; `postgres` — die Rolle, mit der Migrationen laufen —
-- darf sie nicht zurücksetzen („permission denied to set parameter“, lokal
-- gegen supabase/postgres 17.6 belegt). Deshalb dieses Skript als
-- supabase_admin.
--
-- Reihenfolge (Details docs/self-hosting.md „DB-Härtung“):
--   1. Dieses Skript als temporären Coolify Scheduled Task auf der
--      Supabase-Ressource, Container `db` (hinterher Task löschen):
--
--        wget -qO- https://raw.githubusercontent.com/Jannik96D/bordkasse-public/main/webapp/supabase/ops/reset-jwt-setting-2026-11.sql | psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -f -
--
--   2. DANACH die Supabase-Ressource mit der neuen docker-compose.yml neu
--      deployen. RESET wirkt nur auf neue Sitzungen; der Neustart baut alle
--      Verbindungen neu auf, und PostgREST setzt den Wert nicht mehr je
--      Anfrage. Umgekehrt behielten Pool-Verbindungen, die zwischen Neustart
--      und Reset entstehen, den Wert bis zu ihrem Ende.
--
-- Gibt NIE den Wert aus, nur ja/nein. Idempotent (RESET auf eine nicht
-- gesetzte Einstellung ist kein Fehler). Rückweg, falls doch etwas sie
-- braucht: `ALTER DATABASE postgres SET "app.settings.jwt_secret" TO '…'`
-- als supabase_admin (Wert = JWT_SECRET der Supabase-Ressource).
-- ═══════════════════════════════════════════════════════════════════════

\pset pager off

\echo '== vorher: als Datenbankeinstellung gesetzt?'
SELECT EXISTS (
  SELECT 1 FROM pg_db_role_setting s
  JOIN pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = current_database() AND s.setrole = 0
    AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c
                WHERE c LIKE 'app.settings.jwt_secret=%')
) AS jwt_secret_gesetzt;

ALTER DATABASE postgres RESET "app.settings.jwt_secret";

\echo '== nachher: als Datenbankeinstellung gesetzt? (erwartet: f)'
SELECT EXISTS (
  SELECT 1 FROM pg_db_role_setting s
  JOIN pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = current_database() AND s.setrole = 0
    AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c
                WHERE c LIKE 'app.settings.jwt_secret=%')
) AS jwt_secret_gesetzt;

\echo '== jwt_exp bleibt (kein Geheimnis, erwartet: t)'
SELECT EXISTS (
  SELECT 1 FROM pg_db_role_setting s
  JOIN pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = current_database() AND s.setrole = 0
    AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c
                WHERE c LIKE 'app.settings.jwt_exp=%')
) AS jwt_exp_gesetzt;
