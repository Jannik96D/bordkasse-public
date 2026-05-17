-- ═══════════════════════════════════════════════════════════════════════
-- 0017 — Settlement-Announce-Flag
--
-- Der Skipper drückt nach Törn-Ende einmal "Abrechnung verschicken". Erst
-- dann werden:
--   - Bezahlt-Häkchen für Schulden freigegeben (vorher: Banner "warte auf
--     Skipper-Abrechnung")
--   - E-Mails an alle Crew-Mitglieder mit ihrer Bilanz + Schulden-Plan
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS settlement_announced_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS settlement_announced_by UUID NULL REFERENCES persons(id);
