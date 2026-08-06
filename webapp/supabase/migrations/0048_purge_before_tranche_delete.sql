-- 0048: Purge scheitert an `tx_credit_self`, sobald der Törn einen
--       Anzahlungsplan mit Selbst-Verrechnung des Vorstreckers hat.
--
-- ECHTER PRODUKTIONSFUND: weder der
-- manuelle Lösch-Button noch der nächtliche Cron konnten den Törn purgen. Der
-- Nutzer sah nur „Löschung fehlgeschlagen. Bitte erneut versuchen.", der Cron
-- übersprang den Törn stillschweigend (die Fehlerisolierung aus 0042 fängt die
-- Exception pro Törn ab) — die DSGVO-Löschzusage wurde also unbemerkt
-- verfehlt, dauerhaft und ohne Selbstheilung.
--
-- Mechanik:
--   1. `purge_trip_data` löschte `prepayment_tranches`, BEVOR es die
--      Personenspalten der Buchungen nullte.
--   2. `transactions.tranche_id` hat `ON DELETE SET NULL` → Postgres nullt
--      `tranche_id` in den betroffenen Buchungen.
--   3. Genau dieses Feld ist aber die Ausnahme, über die 0024 den Check
--      `tx_credit_self` für die Eigen-Verrechnung des Vorstreckers geöffnet
--      hat (`credit_from = credit_to` ist NUR erlaubt, solange `tranche_id`
--      gesetzt ist).
--   4. Die Zeile verletzt den Check in dem Moment, in dem die Tranche
--      verschwindet → Exception → der gesamte Purge rollt zurück.
--
-- Fix: die anonymisierende UPDATE VOR die Anzahlungs-Tabellen ziehen. Danach
-- ist `credit_to IS NULL`, und der Check greift unabhängig von `tranche_id`
-- (ein CHECK gilt als erfüllt, sobald der Ausdruck NULL ergibt). Bewusst wird
-- NICHT der Check gelockert: er verhindert weiterhin sinnlose A→A-Gutschriften
-- bei der Neuanlage, und die Reihenfolge ist die eigentliche Ursache.
--
-- Die Statistik-Aggregation weiter oben liest ausschließlich Betrag, Datum und
-- Kategorie (keine Personenspalten) — sie ist vom Vorziehen nicht betroffen.
-- Der Orphan-Person-Block am Ende verhält sich unverändert: die UPDATE lief
-- auch vorher schon vor ihm, er sah die genullten Spalten also ohnehin.
--
-- Teil 2 dieser Migration macht Fehlschläge im Cron sichtbar (siehe unten) —
-- dass niemand etwas merkte, lag nicht am Bug allein, sondern daran, dass
-- `purge_expired_trip_data` sie nur als `RAISE WARNING` ins Postgres-Log
-- schrieb und ausschließlich die Erfolgszahl zurückgab.

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

  -- Aggregate sichern (idempotent) — bleibt zusätzlich zu den erhaltenen
  -- Einzelbuchungen bestehen (dient /stats-Gesamtstatistik).
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

  -- ⚠️ MUSS VOR dem Löschen der Anzahlungs-Tabellen laufen (siehe Kopf):
  -- sonst nullt der FK `ON DELETE SET NULL` das `tranche_id` einer
  -- Selbst-Verrechnung und `tx_credit_self` schlägt zu.
  -- Buchungszeilen bleiben erhalten (Betrag, Beschreibung, Alkohol-/
  -- Trinkgeld-Anteil, Datum, Kategorie, Aufteilungsart, Fremdwährungsfelder)
  -- — entfernt wird nur der Personenbezug.
  UPDATE transactions
     SET paid_by = NULL,
         credit_from = NULL,
         credit_to = NULL,
         created_by = NULL
   WHERE trip_id = p_trip_id;

  -- Personenbezogene Tabellen leeren.
  DELETE FROM transaction_participants
    WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = p_trip_id);
  DELETE FROM settled_debts WHERE trip_id = p_trip_id;

  DELETE FROM prepayment_reminder_log WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_obligations WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_tranches WHERE trip_id = p_trip_id;
  DELETE FROM cabin_types WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_plan WHERE trip_id = p_trip_id;

  DELETE FROM trip_members WHERE trip_id = p_trip_id;

  DELETE FROM audit_log WHERE trip_id = p_trip_id;
  -- trip_categories bleiben erhalten (keine Personendaten, sonst würde
  -- transactions.category_id verwaisen).

  UPDATE trips
     SET skipper_id = NULL,
         settlement_announced_by = NULL,
         retention_purged_at = now()
   WHERE id = p_trip_id;

  -- Verwaiste Personen (Ghosts UND anonymisierte Ex-Accounts) nur löschen,
  -- wenn sie NIRGENDS mehr referenziert sind.
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


-- ── Teil 2: Fehlschläge im Cron sichtbar machen ───────────────────────
--
-- Bisher gab `purge_expired_trip_data` nur die Zahl der ERFOLGREICHEN Purges
-- zurück; ein gescheiterter Törn landete als `RAISE WARNING` im Postgres-Log
-- und sonst nirgends. Der Cron-Endpunkt meldete deshalb brav `200 OK` mit
-- `purged_trips: 0` — nicht unterscheidbar von „heute war nichts fällig".
-- Genau deshalb blieb der Bug oben wochenlang unbemerkt, obwohl er jede Nacht
-- erneut zuschlug.
--
-- Jetzt kommt zusätzlich die Zahl der übersprungenen Törns zurück. Der
-- Route-Handler loggt sie als Fehler und gibt sie in der JSON-Antwort aus, die
-- der Coolify Scheduled Task unter „Recent executions" mitschreibt.
--
-- Rückgabetyp ändert sich → DROP nötig, `CREATE OR REPLACE` kann das nicht.
DROP FUNCTION IF EXISTS purge_expired_trip_data();

CREATE FUNCTION purge_expired_trip_data()
RETURNS TABLE (purged INTEGER, failed INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  trip_rec RECORD;
  v_purged INTEGER := 0;
  v_failed INTEGER := 0;
  result TEXT;
BEGIN
  FOR trip_rec IN
    SELECT id FROM trips
    WHERE retention_purged_at IS NULL
      AND end_date < (now() - interval '30 days')::date
      AND settlement_announced_at IS NOT NULL
  LOOP
    -- Jeden Törn in einem eigenen Subtransaktions-Block purgen (0042 Q3b):
    -- ein Fehler rollt nur DIESEN Törn zurück, der Lauf geht weiter.
    BEGIN
      result := purge_trip_data(trip_rec.id, FALSE);
      IF result = 'ok' THEN
        v_purged := v_purged + 1;
      END IF;
      -- 'debts_open' & Co. sind KEIN Fehler: solche Törns landen bewusst
      -- wieder im nächsten Lauf, sobald die Crew abgehakt hat.
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'purge_trip_data(%) fehlgeschlagen: %', trip_rec.id, SQLERRM;
    END;
  END LOOP;

  purged := v_purged;
  failed := v_failed;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION purge_expired_trip_data() TO service_role;
