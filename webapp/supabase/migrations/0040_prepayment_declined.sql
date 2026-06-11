-- ═══════════════════════════════════════════════════════════════════════
-- 0040 — Explizite Entscheidung „Törn ohne Anzahlung"
--
-- Bisher gab es nur den impliziten Zustand „kein Plan angelegt": Der
-- „Jetzt Anzahlung anlegen"-CTA auf der Übersicht nagte bis Törnstart und
-- die Törn-Fortschritt-Karte konnte die Anzahlungsfrage nicht abbilden
-- (das frühere Flag has_charter_prepayment wurde in 0030 entfernt, weil
-- ohne gespeicherte ENTSCHEIDUNG „Plan existiert" die einzige Wahrheit war).
--
-- Jetzt wählt der Skipper bei der Törn-Anlage (bzw. später in den
-- Settings), ob eine Anzahlung vorgesehen ist. Dreizustand:
--   • prepayment_plan existiert      → Charter (gewinnt immer)
--   • prepayment_declined_at gesetzt → bewusst ohne Anzahlung
--   • beides nicht                   → Anzahlung vorgesehen, Plan offen
--     (CTA + Checklisten-Item „Anzahlungsplan anlegen")
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS prepayment_declined_at TIMESTAMPTZ NULL;
