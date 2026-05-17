-- ═══════════════════════════════════════════════════════════════════════
-- 0014 — Aufteilungsart "Pro Person" + Trinkgeld (Teil 1/2)
--
-- Schema-Änderungen für:
-- 1. Neue Aufteilungsart 'per_person' (pro Crew-Mitglied eigener Betrag,
--    z. B. Restaurant-Rechnung wo jeder unterschiedlich bestellt hat).
--    transactions.amount = Σ(participant.amount).
-- 2. Neues Feld transactions.tip_amount: Trinkgeld, das proportional zu
--    den Anteilen auf die Beteiligten verteilt wird.
--
-- Die zugehörigen View-Updates (v_transaction_shares, v_balances) stehen
-- in 0015_per_person_views.sql — Postgres erlaubt die Verwendung eines
-- neu hinzugefügten Enum-Werts erst in einer separaten Transaktion
-- ("unsafe use of new value", SQLSTATE 55P04).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Enum erweitern ────────────────────────────────────────────────
ALTER TYPE split_type ADD VALUE IF NOT EXISTS 'per_person';


-- ── 2. transaction_participants.amount ───────────────────────────────
-- Bei split_type='per_person' enthält jeder Eintrag den individuellen
-- Betrag dieser Person. Bei 'individual' bleibt amount NULL (Liste der
-- markierten Personen ohne Beträge).
ALTER TABLE transaction_participants
  ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tp_amount_nonneg'
  ) THEN
    ALTER TABLE transaction_participants
      ADD CONSTRAINT tp_amount_nonneg CHECK (amount IS NULL OR amount >= 0);
  END IF;
END $$;


-- ── 3. transactions.tip_amount ───────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tx_tip_nonneg'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT tx_tip_nonneg CHECK (tip_amount >= 0);
  END IF;
END $$;
