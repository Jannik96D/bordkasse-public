-- ═══════════════════════════════════════════════════════════════════════
-- 0052 — Gate und tatsächliche Zustellung der Abrechnungs-Mail trennen
-- (Sanierungsplan 2026-09, PR 6, Fund 2)
--
-- Problem: `announceSettlement` (lib/actions/settlement.ts) setzte
-- `trips.settlement_announced_at` UNABHÄNGIG davon, ob auch nur EINE
-- Abrechnungs-Mail tatsächlich zugestellt wurde. `settlement_announced_at`
-- ist aber das GATE für mehrere andere Dinge: die Bezahlt-Häkchen in den
-- Schulden werden dadurch freigeschaltet, der Purge-Blocker
-- (`purge_expired_trip_data`) verlangt es, und die Törn-Fortschritt-
-- Checkliste zeigt "Abrechnung verschickt" als erledigt an.
--
-- Schlägt der komplette Mailversand fehl (z. B. SMTP down), wirkte der
-- Törn danach trotzdem "abgerechnet" — ohne dass irgendjemand aus der
-- Crew eine Mail bekommen hätte. Ein Resend war in diesem Fall NICHT
-- möglich, weil `resendSettlement` zusätzlich `changes_pending_since`
-- verlangt — das wird aber nur durch nachträgliche Buchungsänderungen
-- gesetzt (`mark_post_settlement_change()`), nicht durch einen
-- fehlgeschlagenen Erstversand. Die Crew hätte es also nie erfahren.
--
-- Fix: additive neue Spalte `settlement_mail_sent_at`, die NUR gesetzt
-- wird, wenn der Mailversand mindestens teilweise erfolgreich war
-- (sent > 0). `settlement_announced_at` bleibt unverändert das GATE (wird
-- weiterhin bei jedem `announceSettlement`-Aufruf gesetzt, damit Banner,
-- Checkliste und Purge-Blocker sich nicht ändern). Die App-Logik
-- (lib/actions/settlement.ts) erlaubt `resendSettlement` zusätzlich immer
-- dann, wenn `settlement_mail_sent_at` noch NIE gesetzt wurde (= der
-- erste Versand ist komplett fehlgeschlagen) — unabhängig von
-- `changes_pending_since`. Nach dem ERSTEN erfolgreichen Versand gibt es
-- kein automatisches Zurücksetzen von `settlement_mail_sent_at` mehr.
--
-- Rollback: `ALTER TABLE public.trips DROP COLUMN IF EXISTS
-- settlement_mail_sent_at;` — rein additiv, keine bestehenden Lesepfade
-- referenzieren die Spalte.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS settlement_mail_sent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.trips.settlement_mail_sent_at IS
  'Gesetzt, sobald mindestens eine Abrechnungs-Mail (announce oder resend) tatsächlich erfolgreich zugestellt wurde. Im Unterschied zu settlement_announced_at (dem GATE für Häkchen/Purge/Checkliste) bleibt diese Spalte NULL, wenn der Versand komplett fehlschlug.';

-- Backfill für Bestandsdaten: ein Törn, der schon vor dieser Migration
-- `settlement_announced_at` gesetzt hatte, hat diesen Schritt in aller Regel
-- erfolgreich hinter sich (die neue Unterscheidung existierte ja noch
-- nicht) — ohne Backfill würde `resendSettlement` ihn beim nächsten Aufruf
-- fälschlich als "Erstversand komplett fehlgeschlagen" behandeln und einen
-- Nicht-Update-Resend zulassen, obwohl `changes_pending_since` NULL ist.
UPDATE public.trips
   SET settlement_mail_sent_at = settlement_announced_at
 WHERE settlement_announced_at IS NOT NULL
   AND settlement_mail_sent_at IS NULL;
