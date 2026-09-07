-- ═══════════════════════════════════════════════════════════════════════
-- 0054 — Sanierungsplan 2026-09, PR 7 (Purge/DSGVO): zwei additive
--         Ergänzungen an den bestehenden Purge-Funktionen (letzte Version
--         war 0048_purge_before_tranche_delete.sql).
--
-- (D5) Beschreibung bei GUTSCHRIFTEN nullen:
-- Gutschrift-Freitexte nennen systematisch Namen im Klartext
-- ("Crewwechsel: Lucas übernimmt Anzahlung für Jannik" o. ä., siehe
-- CLAUDE.md-Beispiele im Gutschrift-Abschnitt) — anders als
-- Ausgaben-Beschreibungen ("Lebensmittel Rewe"), die typischerweise keinen
-- Personenbezug tragen. Migration 0044 hat description bewusst für ALLE
-- Buchungen als Erfahrungswert erhalten; das bleibt für type='expense'
-- unverändert so (keine Datengrundlage, um das dort zu rechtfertigen).
-- Für type='credit' wird description jetzt beim Purge zusätzlich zu den
-- Personenspalten genullt.
--
-- (D6) Audit-Log-Hygiene für Törns ohne trip_id:
-- Ein hart gelöschter Törn (deleteTrip) setzt audit_log.trip_id via
-- ON DELETE SET NULL auf NULL. Solche Zeilen sind für NIEMANDEN mehr
-- einsehbar (die RLS-Policy aus 0034 verlangt trip_id IS NOT NULL AND
-- is_trip_skipper(trip_id) — geht mit NULL nicht) und sollen nach 90 Tagen
-- automatisch verschwinden. ⚠️ Die 90 Tage laufen ab `created_at` der
-- AUDIT-ZEILE (der ursprünglichen Aktion), NICHT ab dem Zeitpunkt, an dem
-- der Törn gelöscht wurde — eine 2 Jahre alte Buchungsänderung eines
-- Törns, der erst diese Woche gelöscht wurde, verschwindet also SOFORT
-- beim nächsten Cron-Lauf, nicht erst 90 Tage nach der Löschung (Grill-
-- Review-Klarstellung; praktisch folgenlos, da die Zeilen ohnehin für
-- niemanden einsehbar sind). Läuft im selben täglichen Cron wie
-- der Törn-Purge, zählt aber NICHT in dessen purged/failed-Rückgabe (das
-- sind reine Törn-Purge-Zahlen) und darf einen Fehler hier nicht den
-- Haupt-Lauf verhindern lassen (eigener Fehlerisolierungs-Block, analog
-- zum Per-Törn-Muster aus 0042/0048).
--
-- KEINE anderen Verhaltensänderungen — Rest der Funktionen 1:1 aus 0048
-- übernommen.
-- ═══════════════════════════════════════════════════════════════════════

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

  -- ⚠️ MUSS VOR dem Löschen der Anzahlungs-Tabellen laufen (siehe 0048):
  -- sonst nullt der FK `ON DELETE SET NULL` das `tranche_id` einer
  -- Selbst-Verrechnung und `tx_credit_self` schlägt zu.
  -- Buchungszeilen bleiben erhalten (Betrag, Alkohol-/Trinkgeld-Anteil,
  -- Datum, Kategorie, Aufteilungsart, Fremdwährungsfelder) — entfernt wird
  -- der Personenbezug. NEU (0054, D5): bei Gutschriften (type='credit')
  -- wird zusätzlich die Beschreibung genullt — Gutschrift-Freitexte nennen
  -- systematisch Namen im Klartext ("Crewwechsel: X übernimmt Anzahlung").
  -- Ausgaben-Beschreibungen bleiben unverändert erhalten (0044).
  UPDATE transactions
     SET paid_by = NULL,
         credit_from = NULL,
         credit_to = NULL,
         created_by = NULL,
         description = CASE WHEN type = 'credit' THEN NULL ELSE description END
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


-- ── purge_expired_trip_data: zusätzliche Audit-Log-Hygiene (D6) ────────
--
-- Rückgabetyp (purged, failed) bleibt unverändert seit 0048 → CREATE OR
-- REPLACE reicht, kein DROP nötig.
CREATE OR REPLACE FUNCTION purge_expired_trip_data()
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

  -- NEU (0054, D6): audit_log-Zeilen, deren Törn hart gelöscht wurde
  -- (trip_id IS NULL via ON DELETE SET NULL, siehe deleteTrip), sind für
  -- niemanden mehr einsehbar (RLS aus 0034 verlangt trip_id IS NOT NULL)
  -- und werden ab 90 Tagen (siehe Kopf-Kommentar für die genaue
  -- Zeitbasis) entsorgt. Eigener Fehlerisolierungs-Block: `v_purged`/
  -- `v_failed` sind lokale Variablen, die bereits vor diesem Block final
  -- feststehen (nicht — wie eine frühere Fassung dieses Kommentars
  -- fälschlich behauptete — weil die Schleife oben schon "committed"
  -- wäre; eine PL/pgSQL-Funktion läuft in EINER Transaktion des
  -- Aufrufers, die BEGIN/EXCEPTION-Blöcke sind nur Savepoints). Ein
  -- Fehler hier wird deshalb abgefangen, statt den ganzen Funktionsaufruf
  -- (und damit auch die bereits erfolgreich verarbeiteten Törns) über
  -- eine ungefangene Exception zurückzurollen — der Rückgabewert
  -- (purged/failed = reine Törn-Purge-Zahlen) bleibt unverändert.
  BEGIN
    DELETE FROM audit_log
     WHERE trip_id IS NULL
       AND created_at < now() - interval '90 days';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_log-Bereinigung (trip_id IS NULL, 90 Tage) fehlgeschlagen: %', SQLERRM;
  END;

  purged := v_purged;
  failed := v_failed;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION purge_expired_trip_data() TO service_role;
