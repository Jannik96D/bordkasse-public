-- ═══════════════════════════════════════════════════════════════════════
-- 0024_prepayment_advancer — Wer streckt die Yacht-Anzahlung vor?
--
-- Bisher angenommen: immer der Trip-Skipper. Realität: bei manchen Törns
-- streckt jemand anders das Geld vor (z.B. wer schneller bei der Bank ist,
-- oder eine andere Person aus der Crew). Außerdem hat der Vorstrecker
-- selbst meistens auch einen Anteil an der Yacht zu zahlen — das war
-- bisher durch den `tx_credit_self`-Check geblockt.
--
-- Änderungen:
--   1. prepayment_plan.advancer_person_id (NULL = Trip-Skipper)
--   2. tx_credit_self relaxieren für tranche-getaggte Gutschriften
--      (= reine Eigen-Verrechnung des Vorstreckers, kein echter Geldfluss)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. advancer_person_id ──────────────────────────────────────────────
ALTER TABLE prepayment_plan
  ADD COLUMN IF NOT EXISTS advancer_person_id UUID NULL
  REFERENCES persons(id) ON DELETE SET NULL;

COMMENT ON COLUMN prepayment_plan.advancer_person_id IS
  'Person, die die Yacht-Anzahlung an die Charteragentur vorgestreckt hat. '
  'Crew-Anzahlungen werden gegen diese Person verbucht. NULL = Trip-Skipper.';


-- ── 2. tx_credit_self relaxieren ───────────────────────────────────────
-- Self-credit ist im normalen Bordkasse-Pool sinnlos (kein Geldfluss),
-- aber im Anzahlungs-Pool eine valide Buchung: der Vorstrecker hat schon
-- die Yacht-Buchung (negativer Saldo) und „zahlt" sich jetzt nur seinen
-- eigenen Anteil an — bilanz-neutral.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tx_credit_self') THEN
    ALTER TABLE transactions DROP CONSTRAINT tx_credit_self;
  END IF;
END $$;

ALTER TABLE transactions
  ADD CONSTRAINT tx_credit_self CHECK (
    type <> 'credit'
    OR credit_to IS NULL
    OR credit_to <> credit_from
    OR tranche_id IS NOT NULL  -- Anzahlungs-Pool: Self-Credit erlaubt (Eigen-Verrechnung)
  );
