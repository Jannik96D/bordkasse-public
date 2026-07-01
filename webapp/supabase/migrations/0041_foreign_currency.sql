-- ═══════════════════════════════════════════════════════════════════════
-- 0041 — Fremdwährungen
--
-- Ein Törn kann Buchungen in Fremdwährung haben (z. B. Restaurant in SEK,
-- Hafen in DKK). Der Skipper legt in den Törneinstellungen fest, welche
-- Währungen auf diesem Törn vorkommen (`trips.foreign_currencies`, leer =
-- reiner Euro-Törn → keine Währungs-UI). Beim Buchen wird der Fremdbetrag
-- live zum Tageskurs (open.er-api.com) in Euro umgerechnet; offline greift
-- der Kurs der letzten Buchung derselben Währung.
--
-- WICHTIG — die Bilanz bleibt komplett in EUR:
--   `transactions.amount` (und `transaction_participants.amount`) speichern
--   weiterhin den EUR-Wert, mit dem alle Views (v_balances,
--   v_transaction_shares, …) und lib/calc rechnen. Die neuen Spalten sind
--   reine Herkunfts-/Anzeige-Information (Bon-Spur):
--     • original_currency  — ISO-Code, NULL = EUR nativ
--     • original_amount    — Betrag in Fremdwährung (wie auf dem Bon)
--     • exchange_rate      — 1 Einheit Fremdwährung = X EUR (amount = original_amount × rate)
--     • rate_source        — woher der Kurs kam: 'live' | 'manual' | 'bank'
--     • rate_confirmed_at  — gesetzt, wenn der tatsächliche Bankkurs nachgetragen wurde
--
-- Keine zusätzlichen GRANTs nötig (Spalten erben die Tabellen-Grants aus 0022).
-- Keine View-Änderung nötig (Views lesen nur `amount` = EUR).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS foreign_currencies TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS original_currency  TEXT,
  ADD COLUMN IF NOT EXISTS original_amount    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate      NUMERIC(14,6),
  ADD COLUMN IF NOT EXISTS rate_source        TEXT
    CHECK (rate_source IN ('live', 'manual', 'bank')),
  ADD COLUMN IF NOT EXISTS rate_confirmed_at  TIMESTAMPTZ;

-- Pro-Person-Fremdbetrag: beim Restaurant-Bon trägt jede Person ihren
-- Fremdbetrag ein (den man vom Beleg auseinanderrechnet). `amount` bleibt der
-- EUR-Wert je Person; `original_amount` ist der Fremdbetrag. So kann ein
-- später nachgetragener Bankkurs jede Person sauber neu umrechnen.
ALTER TABLE transaction_participants
  ADD COLUMN IF NOT EXISTS original_amount NUMERIC(12,2);
