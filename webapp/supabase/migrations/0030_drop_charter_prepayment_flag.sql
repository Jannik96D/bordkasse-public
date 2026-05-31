-- ════════════════════════════════════════════════════════════════════════
-- Migration 0030: Charter-Flag entfernen (Konsolidierung)
--
-- trips.has_charter_prepayment (eingeführt in 0029) war ein paralleles
-- "ist Charter"-Konzept neben dem eigentlichen Signal "es existiert ein
-- prepayment_plan". Die Törn-Fortschritt-Checkliste leitet die Anzahlungs-
-- Phase jetzt allein daraus ab, ob ein Plan existiert — das Flag (und der
-- zugehörige Settings-Schalter) entfällt ersatzlos.
--
-- trip_members.checklist_collapsed_at (ebenfalls aus 0029) bleibt unberührt.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE trips DROP COLUMN IF EXISTS has_charter_prepayment;
