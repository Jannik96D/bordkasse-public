-- ════════════════════════════════════════════════════════════════════════
-- Migration 0028: Anzahlungs-Erinnerungs-Log
--
-- Dedup-Log für den täglichen Cron, der 3 Tage vor der jeweiligen Fälligkeit
-- automatisch eine Reminder-Mail schickt.
--
-- Zwei Reminder-Typen:
--   - 'crew_3d'      → 3 Tage vor Crew-Fälligkeit an offene Crew-Mitglieder
--   - 'advancer_3d'  → 3 Tage vor Charter-Fälligkeit an den Vorstrecker
--
-- Pro (Tranche × Person × Typ) wird höchstens eine Mail verschickt — auch
-- wenn der Cron mehrfach am Tag läuft oder wir manuell wiederholen.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE prepayment_reminder_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  tranche_id    UUID NOT NULL REFERENCES prepayment_tranches(id) ON DELETE CASCADE,
  person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('crew_3d', 'advancer_3d')),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tranche_id, person_id, reminder_type)
);

CREATE INDEX prepayment_reminder_log_lookup
  ON prepayment_reminder_log (tranche_id, reminder_type);

COMMENT ON TABLE prepayment_reminder_log IS
  'Dedup-Log für den täglichen Anzahlungs-Reminder-Cron. Pro (tranche × person × type) höchstens ein Eintrag.';

-- RLS: kein Direktzugriff von normalen Usern — Tabelle wird ausschließlich
-- vom Cron mit dem Service-Role-Key gelesen/geschrieben. Service-Role
-- bypassed RLS, also keine Policy nötig; aktivierte RLS sperrt im Fehlerfall
-- (z. B. wenn jemand versehentlich mit User-JWT die Tabelle abruft).
ALTER TABLE prepayment_reminder_log ENABLE ROW LEVEL SECURITY;
