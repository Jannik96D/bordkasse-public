-- ═══════════════════════════════════════════════════════════════════════
-- 0042 — Drei Korrektheits-/DSGVO-Fixes aus dem Code-Review
--
-- Q1  v_balances_bordkasse_only: die credit_received-UNION-ALL wurde nie
--     re-aggregiert (fehlendes GROUP BY, anders als v_balances). Eine Person,
--     die in BEIDEN Zweigen auftaucht (direkte Gutschrift UND „An Alle" von
--     jemand anderem), erzeugte im FULL OUTER JOIN zwei Zeilen mit je vollem
--     paid/share/credit_given → simplify_debts (0027 liest diese View) zählte
--     doppelt → Phantom-Überweisungen, falsche Abrechnungs-Mails und
--     all_debts_settled matchte nie → Törn wurde nie purgebar.
--     Fix: UNION ALL in ein re-aggregierendes CTE wickeln, exakt wie
--     credit_received_per in v_balances (0032).
--
-- Q2  purge_trip_data löschte die Anzahlungs-Tabellen nie. Deren
--     trip_id-CASCADE feuert nicht, weil der Purge die trips-Row nur
--     anonymisiert statt löscht → prepayment_plan (inkl. wero_id),
--     prepayment_obligations, prepayment_tranches, cabin_types und
--     prepayment_reminder_log überlebten die „DSGVO-Löschung".
--     Fix: diese Tabellen explizit trip-scoped löschen.
--
-- Q3  (a) Der Orphan-Ghost-DELETE prüfte nur trip_members. Eine
--         anonymisierte Ex-Person (auth_user_id NULL via delete_my_account),
--         die via trips.settlement_announced_by / transactions.created_by
--         (beide FK ohne ON DELETE) in einem ANDEREN Törn referenziert ist,
--         löste eine FK-Violation aus.
--     (b) purge_expired_trip_data hatte kein Fehler-Handling → eine einzige
--         FK-Violation brach den gesamten Cron-Lauf ab und rollte auch
--         bereits gepurgte Törns zurück.
--     Fix (a): settlement_announced_by beim Purge nullen + Orphan-Cleanup
--         gegen ALLE NO-ACTION-FK-Spalten absichern (nur wirklich
--         unreferenzierte Personen löschen).
--     Fix (b): Per-Törn-Purge im Cron in BEGIN/EXCEPTION kapseln — ein
--         fehlerhafter Törn wird geloggt und übersprungen, der Lauf geht
--         weiter.
--
-- Reiner View-/Function-Rewrite, idempotent (CREATE OR REPLACE). search_path-
-- Pin aus 0033 wird bei den Funktionen INLINE mitgegeben (CREATE OR REPLACE
-- FUNCTION setzt eine nur per ALTER gesetzte Einstellung sonst zurück).
-- ═══════════════════════════════════════════════════════════════════════


-- ── Q1: v_balances_bordkasse_only mit re-aggregierter credit_received ──
CREATE OR REPLACE VIEW v_balances_bordkasse_only AS
WITH bordkasse_tx AS (
  SELECT *
  FROM transactions
  WHERE tranche_id IS NULL
    AND deleted_at IS NULL
),
shares AS (
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
credit_received_direct AS (
  -- credit_to NOT NULL: direkter Empfang
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM bordkasse_tx t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
  GROUP BY t.trip_id, t.credit_to
),
credit_received_alle AS (
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
),
credit_received AS (
  -- ← Fix Q1: die beiden Zweige EINMAL pro (trip, person) zusammenfassen,
  --   sonst dupliziert der FULL OUTER JOIN unten die Personen-Zeile.
  SELECT trip_id, person_id, SUM(amount) AS amount
  FROM (
    SELECT trip_id, person_id, amount FROM credit_received_direct
    UNION ALL
    SELECT trip_id, person_id, amount FROM credit_received_alle
  ) u
  GROUP BY trip_id, person_id
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

-- security_invoker + anon-Entzug aus 0035 explizit erneut setzen (belt &
-- suspenders — CREATE OR REPLACE VIEW behält reloptions zwar bei, aber wir
-- machen die Härtung sichtbar und idempotent).
ALTER VIEW v_balances_bordkasse_only SET (security_invoker = on);
REVOKE SELECT ON v_balances_bordkasse_only FROM anon;
GRANT SELECT ON v_balances_bordkasse_only TO authenticated;


-- ── Q2 + Q3a: purge_trip_data ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION purge_trip_data(p_trip_id UUID, p_force BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_trip RECORD;
BEGIN
  SELECT id, end_date, settlement_announced_at, retention_purged_at
    INTO v_trip
    FROM trips
   WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_trip.retention_purged_at IS NOT NULL THEN
    RETURN 'already_purged';
  END IF;

  IF NOT p_force THEN
    IF v_trip.end_date >= (now() - interval '30 days')::date THEN
      RETURN 'too_young';
    END IF;
    IF v_trip.settlement_announced_at IS NULL THEN
      RETURN 'no_settlement';
    END IF;
  END IF;

  IF NOT all_debts_settled(p_trip_id) THEN
    RETURN 'debts_open';
  END IF;

  -- Aggregate sichern (idempotent)
  INSERT INTO trip_statistics (trip_id, date, category_name, total_amount, alcohol_amount, count)
  SELECT
    t.trip_id,
    t.date,
    COALESCE(c.name, 'Ohne Kategorie') AS category_name,
    SUM(t.amount) AS total_amount,
    SUM(t.alcohol_amount) AS alcohol_amount,
    COUNT(*) AS count
  FROM transactions t
  LEFT JOIN trip_categories c ON c.id = t.category_id
  WHERE t.trip_id = p_trip_id
    AND t.type = 'expense'
    AND t.deleted_at IS NULL
  GROUP BY t.trip_id, t.date, c.name
  ON CONFLICT (trip_id, date, category_name) DO NOTHING;

  -- Audience-Spur — Member mit echtem Login-Account merken.
  INSERT INTO trip_statistics_audience (person_id, trip_id)
  SELECT tm.person_id, tm.trip_id
    FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
   WHERE tm.trip_id = p_trip_id
     AND p.auth_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Personenbezogene Tabellen leeren.
  DELETE FROM transaction_participants
    WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = p_trip_id);
  DELETE FROM settled_debts WHERE trip_id = p_trip_id;

  -- ← Fix Q2: Anzahlungs-Tabellen explizit löschen. Ihr trip_id-CASCADE
  --   feuert nicht, weil die trips-Row unten nur anonymisiert wird.
  --   Reihenfolge: reminder_log (FK → tranches) vor tranches; obligations
  --   und cabin_types vor plan (kein harter FK-Zwang, aber sauber).
  DELETE FROM prepayment_reminder_log WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_obligations WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_tranches WHERE trip_id = p_trip_id;
  DELETE FROM cabin_types WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_plan WHERE trip_id = p_trip_id;

  DELETE FROM trip_members WHERE trip_id = p_trip_id;
  DELETE FROM transactions WHERE trip_id = p_trip_id;
  DELETE FROM audit_log WHERE trip_id = p_trip_id;
  DELETE FROM trip_categories WHERE trip_id = p_trip_id;

  -- ← Fix Q3a: settlement_announced_by mit-nullen, sonst kann der
  --   Orphan-Cleanup unten an diesem FK (kein ON DELETE) scheitern.
  UPDATE trips
     SET skipper_id = NULL,
         settlement_announced_by = NULL,
         retention_purged_at = now()
   WHERE id = p_trip_id;

  -- ← Fix Q3a: verwaiste Personen (Ghosts UND anonymisierte Ex-Accounts)
  --   nur löschen, wenn sie NIRGENDS mehr referenziert sind — sonst würde
  --   eine NO-ACTION-FK aus einem ANDEREN Törn den Purge sprengen. Die
  --   FKs mit ON DELETE CASCADE/SET NULL (settled_debts, audit_log,
  --   persons_private, prepayment_obligations/-reminder_log, advancer,
  --   push_subscriptions, trip_statistics_audience) blockieren nicht und
  --   werden hier bewusst nicht geprüft.
  DELETE FROM persons p
   WHERE p.auth_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_members tm WHERE tm.person_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM trips t
                      WHERE t.skipper_id = p.id OR t.settlement_announced_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transactions tx
                      WHERE tx.paid_by = p.id OR tx.credit_from = p.id
                         OR tx.credit_to = p.id OR tx.created_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transaction_participants tp WHERE tp.person_id = p.id);

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION purge_trip_data(UUID, BOOLEAN) TO service_role;


-- ── Q3b: purge_expired_trip_data mit Per-Törn-Fehler-Isolation ────────
CREATE OR REPLACE FUNCTION purge_expired_trip_data()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  trip_rec RECORD;
  purged_count INTEGER := 0;
  result TEXT;
BEGIN
  FOR trip_rec IN
    SELECT id FROM trips
    WHERE retention_purged_at IS NULL
      AND end_date < (now() - interval '30 days')::date
      AND settlement_announced_at IS NOT NULL
  LOOP
    -- ← Fix Q3b: jeden Törn in einem eigenen Subtransaktions-Block purgen.
    --   Ein Fehler (z. B. eine unerwartete FK-Violation) rollt nur DIESEN
    --   Törn zurück, wird geloggt und übersprungen — der Lauf läuft weiter,
    --   statt alle bereits gepurgten Törns mit zurückzurollen.
    BEGIN
      result := purge_trip_data(trip_rec.id, FALSE);
      IF result = 'ok' THEN
        purged_count := purged_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'purge_trip_data(%) fehlgeschlagen: %', trip_rec.id, SQLERRM;
    END;
    -- Trips mit offenen Schulden landen einfach wieder im nächsten Cron-Lauf.
  END LOOP;
  RETURN purged_count;
END;
$$;

GRANT EXECUTE ON FUNCTION purge_expired_trip_data() TO service_role;
