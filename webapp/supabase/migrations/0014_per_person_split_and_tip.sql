-- ═══════════════════════════════════════════════════════════════════════
-- 0014 — Aufteilungsart "Pro Person" + Trinkgeld-Verteilung
--
-- 1. Neue Aufteilungsart 'per_person': pro Crew-Mitglied wird ein eigener
--    Betrag eingetragen (z. B. Restaurant-Rechnung wo jeder unterschiedlich
--    bestellt hat). transactions.amount = Σ(participant.amount).
-- 2. Neues Feld transactions.tip_amount: Trinkgeld, das proportional zu den
--    Anteilen auf alle Beteiligten verteilt wird (multiplikativer Faktor
--    auf jeden Share — funktioniert für alle Aufteilungsarten).
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


-- ── 4. View v_transaction_shares neu mit per_person + tip ────────────
CREATE OR REPLACE VIEW v_transaction_shares AS
WITH crew AS (
  SELECT
    tm.trip_id,
    tm.person_id,
    COALESCE(tm.on_board_from, t.start_date) AS effective_from,
    COALESCE(tm.on_board_to,   t.end_date)   AS effective_to,
    (COALESCE(tm.on_board_to, t.end_date)
     - COALESCE(tm.on_board_from, t.start_date) + 1) AS days,
    COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE) AS is_alcoholic
  FROM trip_members tm
  JOIN trips t   ON t.id = tm.trip_id
  JOIN persons p ON p.id = tm.person_id
),
tx_per_crew AS (
  SELECT
    t.id AS transaction_id,
    t.trip_id,
    t.date,
    t.amount,
    t.alcohol_amount,
    t.tip_amount,
    t.split_type,
    c.person_id,
    c.days,
    c.is_alcoholic,
    (t.date BETWEEN c.effective_from AND c.effective_to) AS is_present,
    -- Pro-Person-Betrag (nur bei split_type='per_person' relevant)
    (
      SELECT tp.amount FROM transaction_participants tp
      WHERE tp.transaction_id = t.id AND tp.person_id = c.person_id
    ) AS pp_amount,
    CASE t.split_type
      WHEN 'equal'             THEN TRUE
      WHEN 'on_board'          THEN t.date BETWEEN c.effective_from AND c.effective_to
      WHEN 'time_proportional' THEN c.days > 0
      WHEN 'individual'        THEN EXISTS (
        SELECT 1 FROM transaction_participants tp
        WHERE tp.transaction_id = t.id AND tp.person_id = c.person_id
      )
      WHEN 'per_person'        THEN EXISTS (
        SELECT 1 FROM transaction_participants tp
        WHERE tp.transaction_id = t.id
          AND tp.person_id = c.person_id
          AND COALESCE(tp.amount, 0) > 0
      )
    END AS is_in_active_set
  FROM transactions t
  JOIN crew c ON c.trip_id = t.trip_id
  WHERE t.type = 'expense'
),
tx_stats AS (
  SELECT
    transaction_id,
    COUNT(*) FILTER (WHERE is_in_active_set) AS n_active,
    SUM(days) FILTER (WHERE is_in_active_set) AS active_days,
    COUNT(*) FILTER (WHERE is_in_active_set AND is_alcoholic) AS n_active_drinkers,
    SUM(days) FILTER (WHERE is_in_active_set AND is_alcoholic) AS active_drinker_days
  FROM tx_per_crew
  GROUP BY transaction_id
),
base AS (
  SELECT
    tx.transaction_id,
    tx.trip_id,
    tx.person_id,
    tx.amount,
    tx.tip_amount,
    -- Basis-Anteil (ohne Alkohol, ohne Trinkgeld)
    CASE WHEN tx.is_in_active_set THEN
      CASE tx.split_type
        WHEN 'equal'             THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'on_board'          THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'time_proportional' THEN (tx.amount - tx.alcohol_amount) * tx.days / NULLIF(s.active_days, 0)
        WHEN 'individual'        THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'per_person'        THEN COALESCE(tx.pp_amount, 0)
      END
    ELSE 0 END AS base_share,
    -- Alkohol-Anteil
    CASE
      WHEN tx.alcohol_amount > 0 AND tx.is_in_active_set THEN
        CASE
          WHEN s.n_active_drinkers > 0 AND tx.is_alcoholic THEN
            CASE tx.split_type
              WHEN 'time_proportional' THEN tx.alcohol_amount * tx.days / NULLIF(s.active_drinker_days, 0)
              ELSE tx.alcohol_amount / s.n_active_drinkers
            END
          WHEN s.n_active_drinkers = 0 THEN
            CASE tx.split_type
              WHEN 'time_proportional' THEN tx.alcohol_amount * tx.days / NULLIF(s.active_days, 0)
              ELSE tx.alcohol_amount / NULLIF(s.n_active, 0)
            END
          ELSE 0
        END
      ELSE 0
    END AS alcohol_share
  FROM tx_per_crew tx
  JOIN tx_stats s ON s.transaction_id = tx.transaction_id
)
-- Finaler Anteil mit Trinkgeld-Multiplikator:
--   final = (base + alcohol) * (1 + tip / amount)
-- Σ final = (Σ base + Σ alcohol) * (1 + tip/amount) = amount * (1 + tip/amount) = amount + tip
SELECT
  transaction_id,
  trip_id,
  person_id,
  (COALESCE(base_share, 0) + COALESCE(alcohol_share, 0))
    * (1 + COALESCE(tip_amount, 0) / NULLIF(amount, 0)) AS share
FROM base;


-- ── 5. v_balances unverändert — share enthält jetzt schon das Trinkgeld ──
-- Aber: transactions.amount im paid_per-CTE muss tip_amount mit einschließen,
-- weil paid_by die volle Summe (inkl. Trinkgeld) ausgelegt hat.
CREATE OR REPLACE VIEW v_balances AS
WITH crew AS (
  SELECT trip_id, person_id FROM trip_members
),
crew_count AS (
  SELECT trip_id, COUNT(*) AS n FROM trip_members GROUP BY trip_id
),
paid_per AS (
  -- Bezahlt = volle Auslage inkl. Trinkgeld
  SELECT t.trip_id, t.paid_by AS person_id, SUM(t.amount + COALESCE(t.tip_amount, 0)) AS paid
  FROM transactions t
  WHERE t.type = 'expense' AND t.paid_by IS NOT NULL
  GROUP BY t.trip_id, t.paid_by
),
share_per AS (
  SELECT trip_id, person_id, SUM(share) AS share
  FROM v_transaction_shares
  GROUP BY trip_id, person_id
),
credit_given_per AS (
  SELECT t.trip_id, t.credit_from AS person_id, SUM(t.amount) AS credit_given
  FROM transactions t
  WHERE t.type = 'credit' AND t.credit_from IS NOT NULL
  GROUP BY t.trip_id, t.credit_from
),
credit_received_direct AS (
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM transactions t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
  GROUP BY t.trip_id, t.credit_to
),
credit_received_alle AS (
  SELECT t.trip_id, c.person_id, SUM(t.amount / NULLIF(cc.n - 1, 0)) AS amount
  FROM transactions t
  JOIN crew_count cc ON cc.trip_id = t.trip_id
  JOIN crew c        ON c.trip_id  = t.trip_id
  WHERE t.type = 'credit'
    AND t.credit_to IS NULL
    AND c.person_id <> t.credit_from
  GROUP BY t.trip_id, c.person_id
),
credit_received_per AS (
  SELECT trip_id, person_id, SUM(amount) AS credit_received
  FROM (
    SELECT trip_id, person_id, amount FROM credit_received_direct
    UNION ALL
    SELECT trip_id, person_id, amount FROM credit_received_alle
  ) u
  GROUP BY trip_id, person_id
)
SELECT
  c.trip_id,
  c.person_id,
  COALESCE(p.paid, 0)             AS paid,
  COALESCE(s.share, 0)            AS share,
  COALESCE(g.credit_given, 0)     AS credit_given,
  COALESCE(r.credit_received, 0)  AS credit_received,
  COALESCE(p.paid, 0)
    + COALESCE(g.credit_given, 0)
    - COALESCE(s.share, 0)
    - COALESCE(r.credit_received, 0) AS balance
FROM crew c
LEFT JOIN paid_per            p ON p.trip_id = c.trip_id AND p.person_id = c.person_id
LEFT JOIN share_per           s ON s.trip_id = c.trip_id AND s.person_id = c.person_id
LEFT JOIN credit_given_per    g ON g.trip_id = c.trip_id AND g.person_id = c.person_id
LEFT JOIN credit_received_per r ON r.trip_id = c.trip_id AND r.person_id = c.person_id;
