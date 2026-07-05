-- ═══════════════════════════════════════════════════════════════════════
-- 0043 — Drei weitere Code-Review-Fixes (Q4, Q5, Q6)
--
-- Q4  v_balances zählte unbestätigte Pending-Selbstmeldungen
--     (transactions.confirmed_at IS NULL, geschrieben von submitSelfPayment)
--     sofort als credit_given/credit_received — anders als die confirmed-only
--     Anzahlungs-Views (v_prepayment_payments, 0025). Die Abrechnungs-/Update-
--     Mail liest v_balances (getBalances) → der gemailte Pro-Person-Saldo war
--     im Pending-Fenster falsch und inkonsistent zum Zahlungsplan derselben
--     Mail. Fix: confirmed_at-Filter auf die drei credit-CTEs.
--     (normale Skipper-/Admin-Credits haben confirmed_at = now() per DEFAULT
--     → nur die echten Pending-Meldungen fallen raus.)
--     v_balances_bordkasse_only braucht den Filter NICHT: Pending-Meldungen
--     tragen immer eine tranche_id, die dort ohnehin per `tranche_id IS NULL`
--     ausgeschlossen wird.
--
-- Q5  delete_my_account löschte prepayment_obligations + reminder_log der
--     Person nicht — deren CASCADE auf person_id feuert nicht, weil die
--     persons-Row nur anonymisiert statt gelöscht wird (gleiche Wurzel wie
--     Q2/push_subscriptions). Folge: die Anzahlungs-Matrix zeigte weiter
--     „Ehemaliges Crew-Mitglied" mit offenem Soll (DSGVO-Leftover).
--
-- Q6  bump_login_rate_limit (SECURITY DEFINER) war an anon/authenticated
--     freigegeben und per PostgREST /rpc mit beliebigem caller-supplied
--     p_key aufrufbar → gezielter Login-DoS (Fixed-Window-Zähler eines Opfers
--     hochhalten) + Tabellen-Bloat. Der einzige App-Aufruf läuft über den
--     Service-Role-Client (app/login/actions.ts:withinRateLimit) → Freigabe
--     auf service_role beschränken (wie cleanup_login_rate_limit).
--
-- Reiner View-/Function-/Grant-Rewrite, idempotent. search_path-Pin bei der
-- Funktion INLINE (CREATE OR REPLACE FUNCTION würde ihn sonst zurücksetzen).
-- ═══════════════════════════════════════════════════════════════════════


-- ── Q4: v_balances mit confirmed_at-Filter auf den credit-Zweigen ─────
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
    AND t.deleted_at IS NULL
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
    AND t.deleted_at IS NULL
    AND t.confirmed_at IS NOT NULL      -- ← Fix Q4: keine Pending-Meldungen
  GROUP BY t.trip_id, t.credit_from
),
credit_received_direct AS (
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM transactions t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
    AND t.deleted_at IS NULL
    AND t.confirmed_at IS NOT NULL      -- ← Fix Q4
  GROUP BY t.trip_id, t.credit_to
),
credit_received_alle AS (
  SELECT t.trip_id, c.person_id, SUM(t.amount / NULLIF(cc.n - 1, 0)) AS amount
  FROM transactions t
  JOIN crew_count cc ON cc.trip_id = t.trip_id
  JOIN crew c        ON c.trip_id  = t.trip_id
  WHERE t.type = 'credit'
    AND t.credit_to IS NULL
    AND t.deleted_at IS NULL
    AND t.confirmed_at IS NOT NULL      -- ← Fix Q4
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

-- security_invoker + anon-Entzug aus 0035 explizit erneut setzen.
ALTER VIEW v_balances SET (security_invoker = on);
REVOKE SELECT ON v_balances FROM anon;
GRANT SELECT ON v_balances TO authenticated;


-- ── Q5: delete_my_account löscht Anzahlungs-Spuren mit ────────────────
CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_person_id UUID;
  v_active_with_bookings INTEGER;
BEGIN
  SELECT id INTO v_person_id
    FROM persons
   WHERE auth_user_id = auth.uid();

  IF v_person_id IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  -- Blocker: User hat Buchungen in einem AKTIVEN Trip
  -- (end_date >= today AND retention_purged_at IS NULL).
  SELECT COUNT(*) INTO v_active_with_bookings
    FROM trips t
   WHERE t.retention_purged_at IS NULL
     AND t.end_date >= CURRENT_DATE
     AND (
       EXISTS (
         SELECT 1 FROM transactions tx
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND (
              tx.paid_by      = v_person_id OR
              tx.credit_from  = v_person_id OR
              tx.credit_to    = v_person_id
            )
       )
       OR EXISTS (
         SELECT 1 FROM transaction_participants tp
           JOIN transactions tx ON tx.id = tp.transaction_id
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND tp.person_id = v_person_id
       )
     );

  IF v_active_with_bookings > 0 THEN
    RETURN 'has_active_bookings';
  END IF;

  -- 0. Web-Push-Abos löschen — die persons-Row wird unten nur anonymisiert
  --    (nicht gelöscht), daher greift ON DELETE CASCADE hier NICHT.
  DELETE FROM push_subscriptions WHERE person_id = v_person_id;

  -- 0b. ← Fix Q5: Anzahlungs-Spuren löschen (gleiche CASCADE-feuert-nicht-
  --     Logik). prepayment_obligations = Person×Törn-Soll, reminder_log =
  --     verschickte Erinnerungen. Beide sind an anonymisierte Ex-Accounts
  --     sonst DSGVO-Leftover in der Anzahlungs-Matrix. Der Blocker oben
  --     verhindert nicht, dass jemand mit reinem Anzahlungs-Soll (ohne
  --     Buchung) löscht, daher hier explizit.
  DELETE FROM prepayment_reminder_log WHERE person_id = v_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = v_person_id;

  -- 1. Personenbezogene private Daten löschen.
  DELETE FROM persons_private WHERE person_id = v_person_id;

  -- 2. Sichtbarkeits-Marker für gepurgte Trips löschen.
  DELETE FROM trip_statistics_audience WHERE person_id = v_person_id;

  -- 3. Pre-Trip-Mitgliedschaften ohne Buchungs-Spur entfernen.
  DELETE FROM trip_members tm
   WHERE tm.person_id = v_person_id
     AND NOT EXISTS (
       SELECT 1 FROM transactions tx
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND (
            tx.paid_by     = v_person_id OR
            tx.credit_from = v_person_id OR
            tx.credit_to   = v_person_id
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM transaction_participants tp
         JOIN transactions tx ON tx.id = tp.transaction_id
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND tp.person_id = v_person_id
     );

  -- 4. persons-Row anonymisieren.
  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = v_person_id;

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;


-- ── Q6: Rate-Limit-RPC nur noch für service_role ─────────────────────
REVOKE EXECUTE ON FUNCTION bump_login_rate_limit(text, int, int) FROM anon, authenticated;
-- service_role behält die Freigabe aus 0036 (withinRateLimit nutzt den
-- Admin-Client). Kein GRANT nötig — Revoke entfernt nur die zu weiten Rollen.
