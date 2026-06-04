-- ═══════════════════════════════════════════════════════════════════════
-- 0039 — Reise-Typ: Segeltörn vs. Andere Reise
--
-- Bisher war jeder Törn implizit ein Segeltörn. Künftig kann ein Törn als
-- „Andere Reise" markiert werden (z. B. Gruppen-Urlaub). Konsequenzen:
--   • Zählt NICHT in die Gesamtstatistik (/stats) — getGlobalStats filtert
--     auf trip_type = 'sailing'. Die Pro-Törn-Statistik der Reise bleibt
--     erhalten.
--   • Zeigt in der Oberfläche neutrales Wording (Reisegruppe statt Crew,
--     Urlaubsanzahlung statt Yacht/Charter) — siehe lib/trip-vocab.ts.
--
-- Default 'sailing' → alle bestehenden Törns bleiben Segeltörns. Keine
-- zusätzlichen GRANTs nötig (Spalte erbt die Tabellen-Grants aus 0022).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS trip_type TEXT NOT NULL DEFAULT 'sailing'
  CHECK (trip_type IN ('sailing', 'other'));
