-- ═══════════════════════════════════════════════════════════════════════
-- 0006_audit_log — Append-only Logbuch aller Schreib-Operationen
--
-- Wird von den Server Actions nach jedem erfolgreichen INSERT/UPDATE/DELETE
-- gefüllt. Zweck: Forensik, falls die Crew sich fragt "wer hat das gelöscht
-- bzw. geändert?". Lesen ausschließlich Skipper und Admins (App-seitig).
--
-- Bewusst keine RLS-Insert-Policy — wir schreiben über den Service-Role-
-- Client (siehe lib/supabase/admin.ts), RLS bypasst dann sowieso.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name        TEXT NOT NULL,
  operation         TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  record_id         UUID,
  trip_id           UUID REFERENCES trips(id) ON DELETE SET NULL,
  actor_person_id   UUID REFERENCES persons(id) ON DELETE SET NULL,
  payload           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_actor      ON audit_log(actor_person_id);
CREATE INDEX idx_audit_log_record     ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_log_trip       ON audit_log(trip_id);

-- RLS strikt: nur Skipper des betroffenen Trips dürfen Einträge lesen.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_select_skipper"
  ON audit_log FOR SELECT
  TO authenticated
  USING (trip_id IS NULL OR is_trip_skipper(trip_id));
