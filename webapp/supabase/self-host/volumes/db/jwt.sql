-- Sicherheitsrunde 2026-11, Slice 18: das JWT-Secret wird NICHT mehr als
-- Datenbankeinstellung `app.settings.jwt_secret` abgelegt — sie war per
-- `current_setting()` für jede Rolle lesbar (auch anon), und nichts in der
-- Datenbank liest sie (pgTAP db_hardening_test.sql). Läuft nur bei einem
-- leeren Datenverzeichnis; bestehende Installationen setzen den Wert einmalig
-- mit supabase/ops/reset-jwt-setting-2026-11.sql zurück.
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
