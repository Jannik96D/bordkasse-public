-- ═══════════════════════════════════════════════════════════════════════
-- 0026_bordkasse_only_balances — Drei-Block-Bilanz fixen
--
-- Bisher zeigte die Drei-Block-Übersicht den Bordkasse-Saldo als
-- (r.balance − prepayBalance), was bei „niemand hat noch in die
-- Anzahlung eingezahlt"-Szenarien das Vorzeichen invertierte.
--
-- Saubere Lösung: zwei separate Views, die das Aggregat jeweils
-- gefiltert auf `tranche_id IS NULL` (Bordkasse) bzw. `IS NOT NULL`
-- (Anzahlung) berechnen — analog zu v_balances aus 0002_views.sql /
-- 0015_per_person_views.sql.
--
-- v_balances bleibt unverändert (zeigt den GESAMT-Saldo); diese Migration
-- fügt nur eine zusätzliche View hinzu, die nur die Bordkasse-Pool-
-- Buchungen aggregiert.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_balances_bordkasse_only AS
WITH bordkasse_tx AS (
  SELECT *
  FROM transactions
  WHERE tranche_id IS NULL
    AND deleted_at IS NULL
),
shares AS (
  -- Wie v_transaction_shares, aber nur für Bordkasse-Buchungen.
  -- Wir nutzen die existierende View und filtern auf transaction_ids
  -- aus bordkasse_tx.
  SELECT s.*
  FROM v_transaction_shares s
  WHERE s.transaction_id IN (SELECT id FROM bordkasse_tx)
),
paid AS (
  SELECT t.trip_id, t.paid_by AS person_id, SUM(t.amount + COALESCE(t.tip_amount, 0)) AS amount
  FROM bordkasse_tx t
  WHERE t.type = 'expense' AND t.paid_by IS NOT NULL
  GROUP BY t.trip_id, t.paid_by
),
share_per_person AS (
  SELECT s.trip_id, s.person_id, SUM(s.share) AS amount
  FROM shares s
  GROUP BY s.trip_id, s.person_id
),
credit_given AS (
  SELECT t.trip_id, t.credit_from AS person_id, SUM(t.amount) AS amount
  FROM bordkasse_tx t
  WHERE t.type = 'credit' AND t.credit_from IS NOT NULL
  GROUP BY t.trip_id, t.credit_from
),
credit_received AS (
  -- credit_to NOT NULL: direkter Empfang
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM bordkasse_tx t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
  GROUP BY t.trip_id, t.credit_to
  UNION ALL
  -- credit_to NULL = „An Alle": gleichmäßig auf alle anderen Members
  SELECT t.trip_id, tm.person_id, SUM(t.amount / NULLIF(member_count - 1, 0)) AS amount
  FROM bordkasse_tx t
  JOIN trip_members tm ON tm.trip_id = t.trip_id AND tm.person_id <> t.credit_from
  JOIN (
    SELECT trip_id, COUNT(*)::INT AS member_count
    FROM trip_members
    GROUP BY trip_id
  ) mc ON mc.trip_id = t.trip_id
  WHERE t.type = 'credit' AND t.credit_to IS NULL
  GROUP BY t.trip_id, tm.person_id
)
SELECT
  COALESCE(p.trip_id, s.trip_id, cg.trip_id, cr.trip_id) AS trip_id,
  COALESCE(p.person_id, s.person_id, cg.person_id, cr.person_id) AS person_id,
  COALESCE(p.amount, 0) AS paid,
  COALESCE(s.amount, 0) AS share,
  COALESCE(cg.amount, 0) AS credit_given,
  COALESCE(cr.amount, 0) AS credit_received,
  ROUND(
    COALESCE(p.amount, 0) - COALESCE(s.amount, 0)
    + COALESCE(cg.amount, 0) - COALESCE(cr.amount, 0)
  , 2) AS balance
FROM paid p
FULL OUTER JOIN share_per_person s
  ON p.trip_id = s.trip_id AND p.person_id = s.person_id
FULL OUTER JOIN credit_given cg
  ON COALESCE(p.trip_id, s.trip_id) = cg.trip_id
  AND COALESCE(p.person_id, s.person_id) = cg.person_id
FULL OUTER JOIN credit_received cr
  ON COALESCE(p.trip_id, s.trip_id, cg.trip_id) = cr.trip_id
  AND COALESCE(p.person_id, s.person_id, cg.person_id) = cr.person_id;

GRANT SELECT ON v_balances_bordkasse_only TO authenticated;

COMMENT ON VIEW v_balances_bordkasse_only IS
  'Wie v_balances, aber nur Buchungen mit tranche_id IS NULL (also Bordkasse, '
  'ohne Anzahlungs-Pool). Wird in der Drei-Block-Bilanz für die mittlere '
  'Spalte verwendet, damit der Anzahlungs-Pool die Bordkasse-Position nicht '
  'verfälscht.';
