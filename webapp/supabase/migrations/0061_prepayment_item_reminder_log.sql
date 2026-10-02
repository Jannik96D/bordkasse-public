-- ═══════════════════════════════════════════════════════════════════════
-- 0061 — Automatische Erinnerungen für Reise-Posten (PR5)
--
-- Der tägliche Anzahlungs-Cron (/api/cron/prepayment-reminders) verschickt
-- zusätzlich zu den Tranchen-Erinnerungen jetzt auch Erinnerungen für
-- Reise-Posten (0058):
--   • 'item_crew_3d'  → ab 6 Tage vor der Fälligkeit beim Anbieter (= 3 Tage
--                       vor der Crewfrist, toCrewDueDate) an jede Person mit
--                       offenem Posten-Soll.
--   • 'item_payee_3d' → ab 3 Tage vor der Fälligkeit an den Empfänger des
--                       Postens, solange der Anbieter nicht voll bezahlt ist.
-- Pro (Posten × Person × Typ) höchstens EINE Mail — dieses Log ist der
-- Dedup (gleiches Muster wie prepayment_reminder_log aus 0028; Mail zuerst,
-- dann Log-Eintrag mit ON CONFLICT bzw. harmloser 23505).
--
-- Was diese Migration tut:
--   1. prepayment_item_reminder_log (Composite-FK auf den Posten, CASCADE)
--   2. RLS an, KEINE Policy, explizite REVOKE/GRANT → nur Service-Role
--   3. purge_trip_data / admin_delete_person_data / delete_my_account
--      räumen das Log mit ab (DSGVO; 1:1 aus 0058, Ergänzungen markiert
--      mit „0061"). REVOKE/GRANT der Funktionen wie in 0049/0051/0058.
--
-- Additiv: neue Tabelle, die drei Funktionen löschen nur zusätzlich. Der
-- ALTE App-Code kennt die Tabelle nicht und wird nicht berührt.
--
-- ⚠️ DEPLOY-REIHENFOLGE: diese Migration VOR dem App-Deploy einspielen.
-- Ohne die Tabelle scheitert der Posten-Teil des Crons fail-soft (zählt als
-- `failed`, KEINE Mail ohne Dedup), der Tranchen-Teil läuft unverändert.
-- Danach ggf. `NOTIFY pgrst, 'reload schema';`.
--
-- Spec: docs/prepayments.md, Abschnitt „Weitere Posten — Erinnerungen (PR5)"
-- Test: supabase/tests/prepayment_item_reminder_log_test.sql
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. prepayment_item_reminder_log ─────────────────────────────────────
-- trip_id redundant mitgeführt (Composite-FK auf den Posten wie bei
-- prepayment_item_obligations): der Purge löscht per trip_id, und ein Log
-- kann nie auf einen Posten eines fremden Törns zeigen.
-- ON DELETE CASCADE am Posten: ein gelöschter Posten nimmt seine Log-Zeilen
-- mit (ein neuer Posten bekommt eine neue ID → frische Erinnerungen).
-- person_id CASCADE wie 0028: der Orphan-Cleanup des Purge und der
-- Ghost-Merge löschen Personen hart.
CREATE TABLE IF NOT EXISTS prepayment_item_reminder_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL,
  person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pirl_type   CHECK (reminder_type IN ('item_crew_3d', 'item_payee_3d')),
  CONSTRAINT pirl_unique UNIQUE (item_id, person_id, reminder_type),
  CONSTRAINT pirl_item_fk FOREIGN KEY (item_id, trip_id)
    REFERENCES prepayment_items(id, trip_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_reminder_log_trip   ON prepayment_item_reminder_log(trip_id);
CREATE INDEX IF NOT EXISTS idx_item_reminder_log_person ON prepayment_item_reminder_log(person_id);

COMMENT ON TABLE prepayment_item_reminder_log IS
  'Dedup-Log für die Posten-Erinnerungen des täglichen Anzahlungs-Crons. Pro (item × person × type) höchstens ein Eintrag.';


-- ── 2. RLS + Rechte ──────────────────────────────────────────────────────
-- Kein Direktzugriff für Nutzer: ausschließlich der Cron (Service-Role)
-- liest/schreibt, plus rejectItemSelfPayment (ebenfalls Service-Role).
-- RLS ohne Policy sperrt anon/authenticated auch dann, wenn eine Default-
-- ACL (0022) doch ein Recht vergibt; die REVOKEs machen die Absicht explizit
-- (Fund 44).
ALTER TABLE prepayment_item_reminder_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON prepayment_item_reminder_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON prepayment_item_reminder_log TO service_role;


-- ── 3a. purge_trip_data: Posten-Erinnerungs-Log mit abräumen ────────────
-- 1:1 aus 0058, einzige Änderung markiert mit „0061" (DELETE des Logs VOR
-- dem Posten-Delete; der anonymisierende UPDATE bleibt — Lehre 0048 — vor
-- allen Deletes). Kommentare mit „0058" stammen aus der Vorgängerfassung.
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

  -- Aggregate sichern (idempotent). Posten-Ausgaben zählen wie Tranchen-
  -- Ausgaben mit (type='expense').
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

  INSERT INTO trip_statistics_audience (person_id, trip_id)
  SELECT tm.person_id, tm.trip_id
    FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
   WHERE tm.trip_id = p_trip_id
     AND p.auth_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- ⚠️ MUSS VOR dem Löschen der Anzahlungs- und Posten-Tabellen laufen
  -- (siehe 0048): sonst nullt der FK `ON DELETE SET NULL` das `tranche_id`
  -- einer Selbst-Verrechnung und `tx_credit_self` schlägt zu. Nach diesem
  -- UPDATE ist credit_to NULL, der Check also unabhängig erfüllt.
  -- 0058: zusätzlich `item_id = NULL` — der Lösch-Schutz-Trigger auf
  -- prepayment_items blockt sonst (bestätigte Zahlungen hängen dran). Die
  -- Topf-Zuordnung geht damit verloren, genau wie tranche_id über den FK.
  UPDATE transactions
     SET paid_by = NULL,
         credit_from = NULL,
         credit_to = NULL,
         created_by = NULL,
         item_id = NULL,
         description = CASE WHEN type = 'credit' THEN NULL ELSE description END
   WHERE trip_id = p_trip_id;

  DELETE FROM transaction_participants
    WHERE transaction_id IN (SELECT id FROM transactions WHERE trip_id = p_trip_id);
  DELETE FROM settled_debts WHERE trip_id = p_trip_id;

  DELETE FROM prepayment_reminder_log WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_obligations WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_tranches WHERE trip_id = p_trip_id;
  DELETE FROM cabin_types WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_plan WHERE trip_id = p_trip_id;

  -- 0058: Posten-Soll (personenbezogen) + Posten (payee_person_id). Beide
  -- hängen per trip_id-CASCADE an trips, das feuert hier aber nie — die
  -- trips-Zeile wird nur anonymisiert, nicht gelöscht.
  -- 0061: Erinnerungs-Log der Posten (person_id!). Hinge per Composite-FK
  -- auch per CASCADE am Posten, explizit ist es unabhängig davon, ob ein
  -- späterer Umbau den Posten-Delete einmal weglässt.
  DELETE FROM prepayment_item_reminder_log WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_item_obligations WHERE trip_id = p_trip_id;
  DELETE FROM prepayment_items WHERE trip_id = p_trip_id;

  DELETE FROM trip_members WHERE trip_id = p_trip_id;

  DELETE FROM audit_log WHERE trip_id = p_trip_id;

  UPDATE trips
     SET skipper_id = NULL,
         settlement_announced_by = NULL,
         retention_purged_at = now()
   WHERE id = p_trip_id;

  -- Verwaiste Personen nur löschen, wenn sie NIRGENDS mehr referenziert
  -- sind. 0058: auch nicht als Posten-Empfänger (FK RESTRICT — sonst bräche
  -- der ganze Purge ab, wenn eine Ex-Person in einem ANDEREN Törn noch
  -- Empfänger eines Postens ist) und nicht mit Posten-Soll in einem anderen
  -- Törn (FK CASCADE — sonst verschwände dort still ein Soll).
  DELETE FROM persons p
   WHERE p.auth_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trip_members tm WHERE tm.person_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM trips t
                      WHERE t.skipper_id = p.id OR t.settlement_announced_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transactions tx
                      WHERE tx.paid_by = p.id OR tx.credit_from = p.id
                         OR tx.credit_to = p.id OR tx.created_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM transaction_participants tp WHERE tp.person_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM prepayment_items pi WHERE pi.payee_person_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM prepayment_item_obligations pio WHERE pio.person_id = p.id);

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION purge_trip_data(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_trip_data(UUID, BOOLEAN) TO service_role;


-- ── 3b. admin_delete_person_data: Posten-Erinnerungs-Log mit löschen ─────
-- 1:1 aus 0058, einzige Änderung markiert mit „0061" (DELETE des Logs der
-- Person). Die folgende Beschreibung der 0058-Änderungen gilt unverändert:
--   • DELETE prepayment_item_obligations.
--   • Neuer Blocker `is_active_item_payee` (Review-Fund M1): ist die Person
--     Empfänger eines Postens in einem laufenden Törn (end_date >= heute,
--     nicht gepurged), wird abgewiesen — AUCH ohne jede Buchung. Sonst
--     würde sie anonymisiert und aus trip_members entfernt (keine
--     Buchungsspur), und jede spätere Crew-Gutschrift an sie (credit_to =
--     payee) fiele aus v_balances (rein mitgliedschaftsgetrieben) → Σ ≠ 0.
--     `has_active_bookings` greift hier nicht, weil es nur Buchungen prüft.
--   • Ein Posten-Empfänger bleibt Mitglied seines Törns (trip_members wird
--     für ihn nicht gelöscht) — auch nach Törnende zahlt die Crew oft noch
--     Flüge zurück; ohne Mitgliedschaft fielen diese Gutschriften aus
--     v_balances (Σ ≠ 0).
-- In einem abgelaufenen Törn bleibt `payee_person_id` bewusst stehen: die
-- persons-Zeile wird nur anonymisiert (nicht gelöscht), der Posten zeigt
-- dann auf „Ehemaliges Crew-Mitglied" — wie advancer_person_id beim
-- Charter-Plan. Der Blocker `has_active_bookings` deckt Posten-Buchungen
-- automatisch mit ab (paid_by/credit_from/credit_to).
CREATE OR REPLACE FUNCTION admin_delete_person_data(p_person_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_active_with_bookings INTEGER;
BEGIN
  IF p_person_id IS NULL OR NOT EXISTS (SELECT 1 FROM persons WHERE id = p_person_id) THEN
    RETURN 'not_authenticated';
  END IF;

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
              tx.paid_by      = p_person_id OR
              tx.credit_from  = p_person_id OR
              tx.credit_to    = p_person_id
            )
       )
       OR EXISTS (
         SELECT 1 FROM transaction_participants tp
           JOIN transactions tx ON tx.id = tp.transaction_id
          WHERE tx.trip_id = t.id
            AND tx.deleted_at IS NULL
            AND tp.person_id = p_person_id
       )
     );

  IF v_active_with_bookings > 0 THEN
    RETURN 'has_active_bookings';
  END IF;

  -- 0058: Posten-Empfänger in einem laufenden Törn (siehe Kopfkommentar).
  IF EXISTS (
    SELECT 1 FROM prepayment_items pi
      JOIN trips t ON t.id = pi.trip_id
     WHERE pi.payee_person_id = p_person_id
       AND t.retention_purged_at IS NULL
       AND t.end_date >= CURRENT_DATE
  ) THEN
    RETURN 'is_active_item_payee';
  END IF;

  DELETE FROM push_subscriptions WHERE person_id = p_person_id;

  DELETE FROM prepayment_reminder_log WHERE person_id = p_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = p_person_id;
  -- 0058: Posten-Soll (gleiche CASCADE-feuert-nicht-Logik).
  DELETE FROM prepayment_item_obligations WHERE person_id = p_person_id;
  -- 0061: Posten-Erinnerungs-Log der Person.
  DELETE FROM prepayment_item_reminder_log WHERE person_id = p_person_id;

  DELETE FROM persons_private WHERE person_id = p_person_id;

  DELETE FROM trip_statistics_audience WHERE person_id = p_person_id;

  DELETE FROM trip_members tm
   WHERE tm.person_id = p_person_id
     AND NOT EXISTS (
       SELECT 1 FROM transactions tx
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND (
            tx.paid_by     = p_person_id OR
            tx.credit_from = p_person_id OR
            tx.credit_to   = p_person_id
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM transaction_participants tp
         JOIN transactions tx ON tx.id = tp.transaction_id
        WHERE tx.trip_id = tm.trip_id
          AND tx.deleted_at IS NULL
          AND tp.person_id = p_person_id
     )
     -- 0058: Posten-Empfänger bleibt Crew dieses Törns (Grill-Fund), auch
     -- nach Törnende: späte Rückzahlungen der Crew (credit_to = Empfänger)
     -- wirken sonst nicht mehr in der mitgliedschaftsgetriebenen
     -- v_balances → Σ ≠ 0.
     AND NOT EXISTS (
       SELECT 1 FROM prepayment_items pi
        WHERE pi.trip_id = tm.trip_id
          AND pi.payee_person_id = p_person_id
     );

  UPDATE audit_log SET actor_person_id = NULL WHERE actor_person_id = p_person_id;

  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = p_person_id;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION admin_delete_person_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_person_data(UUID) TO service_role;


-- ── 3c. delete_my_account (Altpfad) parallel nachziehen ─────────────────
-- 1:1 aus 0058, einzige Änderung markiert mit „0061" (DELETE des Logs).
-- Wird von der App seit 0051 nicht mehr gerufen (auth.uid() ist über den
-- Service-Role-Client NULL), bleibt laut 0051 aber bis zum Drop im
-- Folge-PR bestehen — und soll bis dahin nicht hinter der neuen Function
-- zurückfallen. 1:1 aus 0043 plus DELETE prepayment_item_obligations, dem
-- Blocker `is_active_item_payee` und der erhaltenen Mitgliedschaft eines
-- Posten-Empfängers (wie oben).
-- Rechte unverändert (CREATE OR REPLACE behält die ACL aus 0021/0043).
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

  -- 0058: Posten-Empfänger in einem laufenden Törn (wie admin_delete_person_data).
  IF EXISTS (
    SELECT 1 FROM prepayment_items pi
      JOIN trips t ON t.id = pi.trip_id
     WHERE pi.payee_person_id = v_person_id
       AND t.retention_purged_at IS NULL
       AND t.end_date >= CURRENT_DATE
  ) THEN
    RETURN 'is_active_item_payee';
  END IF;

  DELETE FROM push_subscriptions WHERE person_id = v_person_id;

  DELETE FROM prepayment_reminder_log WHERE person_id = v_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = v_person_id;
  -- 0058
  DELETE FROM prepayment_item_obligations WHERE person_id = v_person_id;
  -- 0061
  DELETE FROM prepayment_item_reminder_log WHERE person_id = v_person_id;

  DELETE FROM persons_private WHERE person_id = v_person_id;

  DELETE FROM trip_statistics_audience WHERE person_id = v_person_id;

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
     )
     -- 0058: Posten-Empfänger bleibt Crew dieses Törns (Grill-Fund), auch
     -- nach Törnende: späte Rückzahlungen der Crew (credit_to = Empfänger)
     -- wirken sonst nicht mehr in der mitgliedschaftsgetriebenen
     -- v_balances → Σ ≠ 0.
     AND NOT EXISTS (
       SELECT 1 FROM prepayment_items pi
        WHERE pi.trip_id = tm.trip_id
          AND pi.payee_person_id = v_person_id
     );

  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = v_person_id;

  RETURN 'ok';
END;
$$;
