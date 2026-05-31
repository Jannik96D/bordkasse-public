-- ════════════════════════════════════════════════════════════════════════
-- Migration 0029: Törn-Fortschritt-Checkliste
--
-- Zwei schmale Spalten für die "Dein Törn im Überblick"-Karte auf der
-- Trip-Übersicht (sichtbar nur für Skipper/Co-Skipper/Admin):
--
--   trips.has_charter_prepayment
--     Beim Törn-Anlegen gesetzter Schalter "Mit Charter-Anzahlung". Steuert,
--     ob die Anzahlungs-Items in der Checkliste erscheinen. Die Karte zeigt
--     die Items zusätzlich, sobald ein prepayment_plan existiert (OR-Fallback).
--
--   trip_members.checklist_collapsed_at
--     Pro Crew-Mitglied: wann wurde die Karte zuletzt minimiert (NULL = offen).
--     Bewusst pro Member in der DB statt localStorage, damit der Zustand über
--     Geräte (Handy + Laptop) hinweg konsistent ist.
--
-- Keine neuen GRANTs nötig — Spalten auf bestehenden Tabellen erben die
-- Rechte (siehe Konvention Migration 0022).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS has_charter_prepayment BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE trip_members
  ADD COLUMN IF NOT EXISTS checklist_collapsed_at TIMESTAMPTZ;

COMMENT ON COLUMN trips.has_charter_prepayment IS
  'Schalter "Mit Charter-Anzahlung" — steuert die Anzahlungs-Items der Törn-Fortschritt-Karte.';

COMMENT ON COLUMN trip_members.checklist_collapsed_at IS
  'Wann das Mitglied die Törn-Fortschritt-Karte zuletzt minimiert hat (NULL = aufgeklappt).';
