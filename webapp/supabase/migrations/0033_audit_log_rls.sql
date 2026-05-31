-- 0033_audit_log_rls — audit_log-SELECT-Policy enger fassen
--
-- Bisher: USING (trip_id IS NULL OR is_trip_skipper(trip_id)) — der
-- `trip_id IS NULL`-Zweig gab JEDEM authentifizierten User Lesezugriff auf
-- alle trip-losen Audit-Einträge (z. B. globale Aktionen). Es gibt keinen
-- User-Lesepfad, der trip-lose Einträge braucht (Schreiben läuft per
-- Service-Role, die RLS ohnehin bypassed). Die offene Bedingung war also
-- reine Angriffsfläche.
--
-- Neu: nur Trip-Skipper sehen die Audit-Einträge ihres Trips, trip-lose
-- Einträge sind für reguläre User unsichtbar.

DROP POLICY IF EXISTS "audit_select_skipper" ON audit_log;

CREATE POLICY "audit_select_skipper"
  ON audit_log FOR SELECT
  TO authenticated
  USING (trip_id IS NOT NULL AND is_trip_skipper(trip_id));
