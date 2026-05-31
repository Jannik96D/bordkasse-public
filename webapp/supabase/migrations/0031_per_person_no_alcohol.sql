-- ═══════════════════════════════════════════════════════════════════════
-- 0029 — "Pro Person": kein separater Alkohol-Anteil
--
-- Bug-Fix: Bei split_type='per_person' ist die Basis (base_share) bereits
-- der volle Einzelbetrag jeder Person, und Σ pp_amount = amount. Der bisherige
-- ELSE-Zweig im finalen SELECT (per_person + tip_distribution='proportional')
-- addierte zusätzlich alcohol_share obendrauf → der Alkohol-Betrag wurde
-- DOPPELT verteilt:
--   Restaurant 60 € (Anna 20, Ben 30, Carla 10), Alkohol 12 €, 2 Trinker
--   → Σ Anteile = 72 € statt 60 € → Bilanz-Summe ≠ 0.
--
-- Fix: alcohol_share wird für 'per_person' auf 0 gezwungen. Damit sind beide
-- per_person-Zweige (equal + proportional) konsistent (der equal-Zweig hatte
-- den Alkohol-Anteil ohnehin nie addiert). Die Einzelbeträge enthalten den
-- Alkohol bereits.
--
-- Spiegelbild in lib/calc/shares.ts (alcoholShareFor → 0 bei per_person).
-- ═══════════════════════════════════════════════════════════════════════

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
    t.tip_distribution,
    t.split_type,
    c.person_id,
    c.days,
    c.is_alcoholic,
    (t.date BETWEEN c.effective_from AND c.effective_to) AS is_present,
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
    tx.tip_distribution,
    tx.split_type,
    tx.is_in_active_set,
    s.n_active,
    CASE WHEN tx.is_in_active_set THEN
      CASE tx.split_type
        WHEN 'equal'             THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'on_board'          THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'time_proportional' THEN (tx.amount - tx.alcohol_amount) * tx.days / NULLIF(s.active_days, 0)
        WHEN 'individual'        THEN (tx.amount - tx.alcohol_amount) / NULLIF(s.n_active, 0)
        WHEN 'per_person'        THEN COALESCE(tx.pp_amount, 0)
      END
    ELSE 0 END AS base_share,
    CASE
      -- "Pro Person": Einzelbeträge enthalten den Alkohol bereits → kein
      -- separater Alkohol-Anteil (sonst Doppel-Verteilung, siehe Kopf).
      WHEN tx.split_type = 'per_person' THEN 0
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
SELECT
  transaction_id,
  trip_id,
  person_id,
  CASE
    -- "Pro Person" + gleich: Basis + Trinkgeld/Anzahl-Beteiligter (flat)
    WHEN split_type = 'per_person' AND tip_distribution = 'equal' AND is_in_active_set THEN
      COALESCE(base_share, 0)
        + COALESCE(tip_amount, 0) / NULLIF(n_active, 0)
    -- Sonst: bisheriger multiplikativer Trinkgeld-Faktor
    ELSE
      (COALESCE(base_share, 0) + COALESCE(alcohol_share, 0))
        * (1 + COALESCE(tip_amount, 0) / NULLIF(amount, 0))
  END AS share
FROM base;
