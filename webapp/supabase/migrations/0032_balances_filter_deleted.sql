-- ═══════════════════════════════════════════════════════════════════════
-- 0032 — Bug-Fix: v_balances + v_transaction_shares ignorieren Soft-Deletes
--
-- Befund (siehe supabase/_e2e_tests.sql Trip D + supabase/tests/
-- balances_soft_delete_test.sql):
--   Soft-gelöschte Buchungen (deleted_at IS NOT NULL) zählten weiterhin in
--   v_balances UND v_transaction_shares. Folge: nach jedem Löschen einer
--   Buchung war
--     • die Bilanz-Seite (balance/page.tsx → getBalances → v_balances) und
--     • der in den Abrechnungs-/Update-Mails angezeigte Saldo
--       (settlement.ts announce/resend nutzt getBalances)
--   falsch (gelöschte Buchung lief weiter mit).
--
--   Der Kommentar an deleteTransaction (lib/actions/transactions.ts) behauptet
--   bereits: "Bilanz, Schulden und Listen filtern deleted_at IS NULL". Das galt
--   aber nur für v_balances_bordkasse_only (0026), die Transaktionsliste und die
--   Statistik — die ursprüngliche v_balances (0002) wurde beim Einführen des
--   Soft-Deletes nie nachgezogen.
--
-- NICHT betroffen (vorab geprüft, kein Fix nötig):
--   • simplify_debts() liest inzwischen v_balances_bordkasse_only (filtert
--     deleted_at) → Schulden-Seite, Zahlungsplan in den Mails und der
--     "Alle Schulden beglichen"-Haken sind bereits korrekt.
--   • Statistik liest transactions direkt mit deleted_at-Filter.
--
-- Fix: deleted_at IS NULL in v_transaction_shares (Quelle der Anteile) und in
--   allen Aggregat-CTEs von v_balances ergänzen. v_balances_bordkasse_only
--   bleibt unberührt (filtert deleted_at ohnehin schon).
--
-- Idempotent: CREATE OR REPLACE VIEW, erneutes Anwenden unschädlich.
-- TS-Mirror lib/calc/* ist nicht betroffen (operiert nur auf bereits
--   gefilterten Eingaben in den Vitest-Tests).
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
    AND t.deleted_at IS NULL          -- ← Fix 0032
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
    WHEN split_type = 'per_person' AND tip_distribution = 'equal' AND is_in_active_set THEN
      COALESCE(base_share, 0)
        + COALESCE(tip_amount, 0) / NULLIF(n_active, 0)
    ELSE
      (COALESCE(base_share, 0) + COALESCE(alcohol_share, 0))
        * (1 + COALESCE(tip_amount, 0) / NULLIF(amount, 0))
  END AS share
FROM base;


CREATE OR REPLACE VIEW v_balances AS
WITH crew AS (
  SELECT trip_id, person_id FROM trip_members
),
crew_count AS (
  SELECT trip_id, COUNT(*) AS n FROM trip_members GROUP BY trip_id
),
paid_per AS (
  SELECT t.trip_id, t.paid_by AS person_id, SUM(t.amount + COALESCE(t.tip_amount, 0)) AS paid
  FROM transactions t
  WHERE t.type = 'expense' AND t.paid_by IS NOT NULL
    AND t.deleted_at IS NULL          -- ← Fix 0032
  GROUP BY t.trip_id, t.paid_by
),
share_per AS (
  SELECT trip_id, person_id, SUM(share) AS share
  FROM v_transaction_shares           -- erbt deleted_at-Filter automatisch
  GROUP BY trip_id, person_id
),
credit_given_per AS (
  SELECT t.trip_id, t.credit_from AS person_id, SUM(t.amount) AS credit_given
  FROM transactions t
  WHERE t.type = 'credit' AND t.credit_from IS NOT NULL
    AND t.deleted_at IS NULL          -- ← Fix 0032
  GROUP BY t.trip_id, t.credit_from
),
credit_received_direct AS (
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM transactions t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
    AND t.deleted_at IS NULL          -- ← Fix 0032
  GROUP BY t.trip_id, t.credit_to
),
credit_received_alle AS (
  SELECT t.trip_id, c.person_id, SUM(t.amount / NULLIF(cc.n - 1, 0)) AS amount
  FROM transactions t
  JOIN crew_count cc ON cc.trip_id = t.trip_id
  JOIN crew c        ON c.trip_id  = t.trip_id
  WHERE t.type = 'credit'
    AND t.credit_to IS NULL
    AND t.deleted_at IS NULL          -- ← Fix 0032
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
