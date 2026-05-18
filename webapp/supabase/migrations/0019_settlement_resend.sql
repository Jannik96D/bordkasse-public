-- ═══════════════════════════════════════════════════════════════════════
-- 0019 — Re-Send Settlement-Mail bei Buchungs-Änderungen nach Abrechnung
--
-- Nach dem Versand der Abrechnungs-Mail kann es noch zu Änderungen kommen
-- (vergessene Buchung, Korrektur, Kaution-Nachbuchung etc.). Wir tracken
-- diese mit:
--   - changes_pending_since: Zeitstempel der ersten Änderung seit dem
--     letzten Mail-Versand. Wird beim Resend zurückgesetzt.
--   - last_settlement_resend_at: Zeitpunkt der letzten Update-Mail. Für
--     Audit und Dedupe.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS changes_pending_since TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_settlement_resend_at TIMESTAMPTZ NULL;

-- Helper-Funktion: setzt changes_pending_since auf NOW, falls die Abrechnung
-- schon verschickt wurde und noch kein offener Hinweis vorliegt.
-- Wird von den Server-Actions create/update/delete Expense + Credit gerufen.
CREATE OR REPLACE FUNCTION mark_post_settlement_change(p_trip_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE trips
     SET changes_pending_since = NOW()
   WHERE id = p_trip_id
     AND settlement_announced_at IS NOT NULL
     AND changes_pending_since IS NULL;
$$;

GRANT EXECUTE ON FUNCTION mark_post_settlement_change(UUID) TO service_role;
