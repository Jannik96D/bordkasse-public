-- ═══════════════════════════════════════════════════════════════════════
-- 0005_idempotency — Idempotency-Key für Transaktionen
--
-- Schützt gegen Duplikate, wenn ein Client bei flakey Yacht-WiFi den
-- Submit retried obwohl die Antwort nur verloren ging. Der Client erzeugt
-- pro Form-Render eine UUID; bei UNIQUE-Verletzung erkennt die Server
-- Action den Retry und redirected normal weiter.
--
-- Spalte ist nullable, damit Bestandsdaten und älterer Code nicht brechen.
-- Der UNIQUE-Index ist partiell — nur befüllte Keys konkurrieren.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE transactions
  ADD COLUMN idempotency_key UUID;

CREATE UNIQUE INDEX idx_transactions_idempotency
  ON transactions(trip_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
