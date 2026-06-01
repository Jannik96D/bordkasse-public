-- ═══════════════════════════════════════════════════════════════════════
-- 0037 — Kaution-verrechnet manuell statt automatisch erkannt
--
-- Der Haken "Kaution verrechnet" in der Törn-Fortschritt-Karte ("Dein Törn
-- im Überblick") wurde bisher automatisch aus dem Datenstand abgeleitet:
-- "existiert eine nicht-gelöschte Buchung in einer Kategorie namens
-- /kaution/i?". Das ist zu fehleranfällig (umbenannte Kategorie, Kaution
-- nur als Gutschrift gegenverrechnet, gar keine eigene Buchung, …).
--
-- Stattdessen setzt der Skipper den Haken jetzt von Hand. Wir tracken den
-- Zeitpunkt — NULL = noch nicht verrechnet, gesetzt = abgehakt.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS deposit_settled_at TIMESTAMPTZ NULL;
