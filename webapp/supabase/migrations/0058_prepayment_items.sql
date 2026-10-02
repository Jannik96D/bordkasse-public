-- ═══════════════════════════════════════════════════════════════════════
-- 0058 — Reise-Posten im Anzahlungsplan (Teil B, PR3 / B-a — nur Datenbank)
--
-- Zusätzlich zur Charter-Anzahlung (prepayment_plan + Tranchen) kann ein
-- Törn weitere „Posten" haben, typisch An-/Abreise (Flug, Bahn). Ein Posten
-- ist ein DRITTER Topf neben Bordkasse und Charter-Pool und funktioniert
-- mechanisch wie die Charter:
--   • Der Empfänger des Postens (`payee_person_id`, i. d. R. wer die Tickets
--     bucht) erfasst die reale Zahlung an Airline/Bahn als AUSGABE mit
--     `item_id`, verteilt auf die Crew gemäß Soll.
--   • Die Crew zahlt ihm ihren Anteil als GUTSCHRIFT mit `item_id`
--     (Selbstmeldung → Bestätigung, `confirmed_at` wie bei den Tranchen).
--   • Sein eigener Anteil ist eine Selbst-Verrechnung (`credit_from =
--     credit_to`, bilanzneutral) — deshalb die `tx_credit_self`-Ausnahme.
--   Ohne die Ausgabe wäre die Gesamtbilanz schief (Crew Gläubiger,
--   Empfänger Schuldner der eigenen Einzahlungen); mit ihr ist Σ v_balances
--   = 0 und jede Person 0, sobald alle gezahlt haben (pgTAP belegt das).
--
-- Was diese Migration tut:
--   1. prepayment_items              (Posten, je Törn beliebig viele)
--   2. prepayment_item_obligations   (Soll je Person und Posten)
--   3. RLS: Lesen für Mitglieder, Schreiben nur Service-Role
--   4. transactions.item_id          (Topf-Zuordnung) + CHECK „nie Tranche
--                                     UND Posten" + tx_credit_self-Ausnahme
--   5. Lösch-Schutz für Posten (Trigger, Fund B4)
--   6. v_balances_bordkasse_only     schließt Posten-Buchungen aus
--      (→ simplify_debts/all_debts_settled bleiben Bordkasse-only, ohne
--      eigene Änderung; v_balances bleibt unverändert die Gesamtbilanz)
--   7. v_prepayment_item_payments / v_prepayment_item_pending
--   8.–10. purge_trip_data / admin_delete_person_data / delete_my_account
--      räumen die neuen Tabellen mit ab (DSGVO)
--
-- Additiv und mit dem ALTEN App-Code verträglich: neue Tabellen, eine
-- nullable Spalte, gelockerte (nicht verschärfte) Checks. Der neue CHECK
-- `tx_pool_exclusive` greift erst, sobald es Zeilen mit `item_id` gibt — die
-- kann nur neuer App-Code (PR4) erzeugen.
--
-- ⚠️ DEPLOY-REIHENFOLGE: erst diese Migration auf Produktion, DANN der
-- App-Deploy. Der App-Code dieses PRs filtert bereits `.is("item_id", null)`
-- (Fortschritts-Checkliste, Crewwechsel, Datenexport, Crewwechsel-Warnung)
-- — ohne die Spalte schlagen diese Queries mit „column does not exist" fehl.
--
-- Spec: docs/prepayments.md (Abschnitt „Weitere Posten")
-- Tests: supabase/tests/prepayment_items_test.sql,
--        supabase/tests/purge_with_item_self_credit_test.sql (+ Erweiterungen
--        in obligations_crew_read / write_rls_lockdown / function_privileges /
--        view_security_invoker)
-- ═══════════════════════════════════════════════════════════════════════


-- ── 0. Composite-Ziel für die Kategorie-Zuordnung ────────────────────────
-- Damit ein Posten nur eine Kategorie DESSELBEN Törns tragen kann, zeigt der
-- FK auf (id, trip_id). `id` ist ohnehin PK, die zusätzliche UNIQUE-Garantie
-- ist also immer erfüllt — sie existiert nur als FK-Ziel.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_categories_id_trip_key') THEN
    ALTER TABLE trip_categories
      ADD CONSTRAINT trip_categories_id_trip_key UNIQUE (id, trip_id);
  END IF;
END $$;


-- ── 1. prepayment_items ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepayment_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- Wofür ist der Posten („An-/Abreise" …)? Nullable: die Kategorie kann
  -- gelöscht werden, Bestandstörns haben evtl. keine passende.
  category_id      UUID NULL,
  label            TEXT NOT NULL,
  total_amount     NUMERIC(10,2) NOT NULL,
  -- Fälligkeit gegenüber dem Anbieter (optional — eine Bahnfahrt hat nicht
  -- immer eine Frist). Pflicht wird ggf. im App-Schema (PR4).
  due_date         DATE NULL,
  -- Wer die Zahlung an den Anbieter leistet und das Geld der Crew empfängt.
  -- RESTRICT statt SET NULL: ein Posten ohne Empfänger hätte niemanden, dem
  -- die Gutschriften zustehen. Personen werden nur vom Purge-Orphan-Cleanup
  -- (unten abgesichert) und vom Ghost-Merge (PR4) hart gelöscht.
  payee_person_id  UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  -- Aufteilungsart für die Soll-Neuberechnung (calculateObligations-Modi
  -- ohne „kojen" — Kojen gibt es nur bei der Yacht). Die tatsächlichen
  -- Sollbeträge stehen in prepayment_item_obligations. Weitere Modi können
  -- in PR4 per Constraint-Tausch ergänzt werden.
  split_type       TEXT NOT NULL,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pi_total_pos      CHECK (total_amount > 0),
  CONSTRAINT pi_label_nonempty CHECK (btrim(label) <> ''),
  CONSTRAINT pi_split_type     CHECK (split_type IN ('gleichmaessig', 'zeitanteilig', 'individuell')),
  -- FK-Ziel für die Composite-FKs aus prepayment_item_obligations und
  -- transactions (Cross-Trip-Schutz auf DB-Ebene).
  CONSTRAINT pi_id_trip_key    UNIQUE (id, trip_id),
  -- Kategorie nur aus DIESEM Törn. Beim Löschen der Kategorie nur
  -- category_id nullen, NICHT trip_id (Spaltenliste, ab PG 15).
  CONSTRAINT pi_category_fk    FOREIGN KEY (category_id, trip_id)
    REFERENCES trip_categories(id, trip_id) ON DELETE SET NULL (category_id)
);

CREATE INDEX IF NOT EXISTS idx_prepayment_items_trip  ON prepayment_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_prepayment_items_payee ON prepayment_items(payee_person_id);

DROP TRIGGER IF EXISTS pi_set_updated_at ON prepayment_items;
CREATE TRIGGER pi_set_updated_at
  BEFORE UPDATE ON prepayment_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 2. prepayment_item_obligations ───────────────────────────────────────
-- Soll je (Posten, Person). trip_id redundant mitgeführt (Composite-FK auf
-- den Posten), damit RLS ohne Join auf is_trip_member(trip_id) prüfen kann
-- und ein Soll nie auf einen Posten eines fremden Törns zeigt.
CREATE TABLE IF NOT EXISTS prepayment_item_obligations (
  item_id     UUID NOT NULL,
  trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (item_id, person_id),
  CONSTRAINT pio_amount_nonneg CHECK (amount >= 0),
  CONSTRAINT pio_item_fk FOREIGN KEY (item_id, trip_id)
    REFERENCES prepayment_items(id, trip_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_obligations_trip   ON prepayment_item_obligations(trip_id);
CREATE INDEX IF NOT EXISTS idx_item_obligations_person ON prepayment_item_obligations(person_id);

DROP TRIGGER IF EXISTS pio_set_updated_at ON prepayment_item_obligations;
CREATE TRIGGER pio_set_updated_at
  BEFORE UPDATE ON prepayment_item_obligations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 3. RLS + Rechte ──────────────────────────────────────────────────────
-- Lesen: alle Mitglieder (Transparenz wie 0057 für prepayment_obligations),
-- plus Self-Klausel für das eigene Soll nach einem Crew-Wechsel.
-- Schreiben: ausschließlich Service-Role (Server Actions). Die Default-
-- Privilegien aus 0050 vergeben ohnehin kein INSERT/UPDATE/DELETE mehr —
-- hier trotzdem explizit, damit die Absicht nicht an einer impliziten
-- Default-ACL hängt (Fund 44: eine neue Tabelle ohne RLS war sofort
-- beschreibbar).
ALTER TABLE prepayment_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE prepayment_item_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pi_select_member" ON prepayment_items;
CREATE POLICY "pi_select_member"
  ON prepayment_items FOR SELECT TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

DROP POLICY IF EXISTS "pio_select_member" ON prepayment_item_obligations;
CREATE POLICY "pio_select_member"
  ON prepayment_item_obligations FOR SELECT TO authenticated
  USING (
    is_trip_member(trip_id)
    OR is_trip_skipper(trip_id)
    OR person_id = current_person_id()
  );

REVOKE ALL ON prepayment_items, prepayment_item_obligations FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON prepayment_items, prepayment_item_obligations FROM authenticated;
GRANT SELECT ON prepayment_items, prepayment_item_obligations TO authenticated;
GRANT ALL ON prepayment_items, prepayment_item_obligations TO service_role;


-- ── 4. transactions.item_id ──────────────────────────────────────────────
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS item_id UUID NULL;

-- Composite-FK: eine Buchung kann nur einem Posten IHRES Törns zugeordnet
-- werden (anders als tranche_id, wo das App-Layer per trancheBelongsToTrip
-- prüfen muss). MATCH SIMPLE: item_id NULL → keine Prüfung.
-- ON DELETE SET NULL (item_id): nur die Zuordnung fällt weg, trip_id bleibt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tx_item_fk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT tx_item_fk FOREIGN KEY (item_id, trip_id)
      REFERENCES prepayment_items(id, trip_id) ON DELETE SET NULL (item_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_item ON transactions(item_id);

-- Eine Buchung gehört höchstens EINEM Sondertopf (Fund B3) — sonst zählte
-- sie in zwei Pools und die Matrix-Summen wären doppelt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tx_pool_exclusive') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT tx_pool_exclusive CHECK (tranche_id IS NULL OR item_id IS NULL);
  END IF;
END $$;

-- tx_credit_self (zuletzt 0024) erweitern:
--   • item_id IS NOT NULL — Selbst-Verrechnung des Posten-Empfängers, exakt
--     analog zur Tranchen-Ausnahme.
--   • deleted_at IS NOT NULL — eine soft-gelöschte Zeile wirkt nirgends
--     mehr (alle Views filtern deleted_at). Ohne diese Ausnahme ließe der
--     FK `ON DELETE SET NULL` beim Löschen eines Postens (oder einer
--     Tranche, siehe saveTranches) jede soft-gelöschte Selbst-Verrechnung
--     mit 23514 scheitern — der Posten wäre auf ewig unlöschbar, obwohl
--     nur „Müll" an ihm hängt (Fund B4). Ein Zurückholen einer solchen
--     Zeile (deleted_at → NULL) prüft den Check erneut und scheitert
--     weiterhin; neue A→A-Gutschriften in der Bordkasse bleiben verboten.
-- Gelockert, nicht verschärft → alle Bestandszeilen erfüllen den neuen Check.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS tx_credit_self;
ALTER TABLE transactions
  ADD CONSTRAINT tx_credit_self CHECK (
    type <> 'credit'
    OR credit_to IS NULL
    OR credit_to <> credit_from
    OR tranche_id IS NOT NULL  -- Anzahlungs-Pool: Eigen-Verrechnung (0024)
    OR item_id IS NOT NULL     -- Posten: Eigen-Verrechnung des Empfängers
    OR deleted_at IS NOT NULL  -- soft-gelöscht: wirkt nicht mehr
  );


-- ── 5. Lösch-Schutz für Posten (Fund B4) ─────────────────────────────────
-- `ON DELETE SET NULL` würde beim Löschen eines Postens jede noch daran
-- hängende Buchung still in die BORDKASSE kippen lassen:
--   • bestätigte Gutschriften/Ausgaben → plötzlich Bordkasse-Salden,
--     Phantom-Überweisungen in simplify_debts;
--   • unbestätigte Selbstmeldungen (confirmed_at NULL) → hängen dann als
--     Pending-Bordkasse-Gutschrift herum, die keine UI mehr bestätigen
--     kann; eine Pending-SELBST-Verrechnung bräche sogar mit 23514.
-- Beides blockt der Trigger mit einer sprechenden Exception (SQLSTATE
-- P0001, Message als stabiler Schlüssel für die App in PR4). Soft-gelöschte
-- Zeilen sind harmlos und werden vom FK entkoppelt (dank deleted_at-
-- Ausnahme oben).
--
-- Ausnahme: wird der ganze TÖRN gelöscht (CASCADE aus trips, deleteTrip),
-- ist die trips-Zeile beim Feuern bereits weg — dann gehen die Buchungen
-- per CASCADE ohnehin mit, es gibt nichts zu schützen. Der Purge entkoppelt
-- vor dem Löschen selbst (`item_id = NULL` im anonymisierenden UPDATE).
--
-- SECURITY DEFINER, damit die Prüfung unabhängig von der RLS des Aufrufers
-- ALLE Buchungen sieht (sonst könnte ein RLS-beschränkter Aufrufer den
-- Schutz umgehen, weil er die blockierenden Zeilen nicht sieht).
CREATE OR REPLACE FUNCTION prepayment_item_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trips WHERE id = OLD.trip_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM transactions
     WHERE item_id = OLD.id
       AND deleted_at IS NULL
       AND confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'prepayment_item_has_payments'
      USING ERRCODE = 'P0001',
            DETAIL = 'An diesem Posten hängen noch bestätigte Zahlungen.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM transactions
     WHERE item_id = OLD.id
       AND deleted_at IS NULL
       AND confirmed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'prepayment_item_has_pending'
      USING ERRCODE = 'P0001',
            DETAIL = 'An diesem Posten hängt noch eine unbestätigte Selbstmeldung.';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION prepayment_item_guard_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pi_guard_delete ON prepayment_items;
CREATE TRIGGER pi_guard_delete
  BEFORE DELETE ON prepayment_items
  FOR EACH ROW EXECUTE FUNCTION prepayment_item_guard_delete();


-- ── 6. v_balances_bordkasse_only ohne Posten-Buchungen ───────────────────
-- 1:1 aus 0042, einzige Änderung: `AND item_id IS NULL` in bordkasse_tx.
-- simplify_debts (0027/0055) liest diese View → Posten erzeugen keine
-- Überweisungen im Schulden-Tab (wie die Charter). v_balances bleibt die
-- Gesamtbilanz über alle drei Töpfe.
CREATE OR REPLACE VIEW v_balances_bordkasse_only AS
WITH bordkasse_tx AS (
  SELECT *
  FROM transactions
  WHERE tranche_id IS NULL
    AND item_id IS NULL
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
  SELECT t.trip_id, t.credit_to AS person_id, SUM(t.amount) AS amount
  FROM bordkasse_tx t
  WHERE t.type = 'credit' AND t.credit_to IS NOT NULL
  GROUP BY t.trip_id, t.credit_to
),
credit_received_alle AS (
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

ALTER VIEW v_balances_bordkasse_only SET (security_invoker = on);
REVOKE SELECT ON v_balances_bordkasse_only FROM anon;
GRANT SELECT ON v_balances_bordkasse_only TO authenticated;


-- ── 7. Posten-Zahlungen (Grundlage für Matrix/Queries in PR4) ────────────
-- Analog v_prepayment_payments (0025): nur BESTÄTIGTE, nicht gelöschte
-- Gutschriften zählen als „bezahlt". Die Anbieter-Zahlung (Ausgabe mit
-- item_id) summiert PR4 direkt aus transactions (Pendant getCharterPaidTotal).
CREATE OR REPLACE VIEW v_prepayment_item_payments AS
SELECT
  t.trip_id,
  t.item_id,
  t.credit_from AS person_id,
  COALESCE(SUM(t.amount), 0) AS paid_amount
FROM transactions t
WHERE t.item_id IS NOT NULL
  AND t.type = 'credit'
  AND t.credit_from IS NOT NULL
  AND t.deleted_at IS NULL
  AND t.confirmed_at IS NOT NULL
GROUP BY t.trip_id, t.item_id, t.credit_from;

-- Analog v_prepayment_pending: offene Selbstmeldungen für ⏳-Zellen.
CREATE OR REPLACE VIEW v_prepayment_item_pending AS
SELECT
  t.id            AS transaction_id,
  t.trip_id,
  t.item_id,
  t.credit_from   AS person_id,
  t.amount,
  t.date,
  t.description,
  t.created_at,
  t.created_by
FROM transactions t
WHERE t.item_id IS NOT NULL
  AND t.type = 'credit'
  AND t.deleted_at IS NULL
  AND t.confirmed_at IS NULL;

ALTER VIEW v_prepayment_item_payments SET (security_invoker = on);
ALTER VIEW v_prepayment_item_pending  SET (security_invoker = on);
REVOKE ALL ON v_prepayment_item_payments, v_prepayment_item_pending FROM anon;
GRANT SELECT ON v_prepayment_item_payments, v_prepayment_item_pending TO authenticated;


-- ── 8. purge_trip_data: Posten mit abräumen ──────────────────────────────
-- 1:1 aus 0054, Änderungen markiert mit „0058".
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


-- ── 9. admin_delete_person_data: Posten-Soll mit löschen ─────────────────
-- 1:1 aus 0051, einzige Änderung: DELETE prepayment_item_obligations.
-- `payee_person_id` bleibt bewusst stehen: die persons-Zeile wird nur
-- anonymisiert (nicht gelöscht), der Posten zeigt dann auf „Ehemaliges
-- Crew-Mitglied" — wie advancer_person_id beim Charter-Plan. Der Blocker
-- `has_active_bookings` deckt Posten-Buchungen automatisch mit ab (paid_by/
-- credit_from/credit_to).
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

  DELETE FROM push_subscriptions WHERE person_id = p_person_id;

  DELETE FROM prepayment_reminder_log WHERE person_id = p_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = p_person_id;
  -- 0058: Posten-Soll (gleiche CASCADE-feuert-nicht-Logik).
  DELETE FROM prepayment_item_obligations WHERE person_id = p_person_id;

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


-- ── 10. delete_my_account (Altpfad, 0043) parallel nachziehen ────────────
-- Wird von der App seit 0051 nicht mehr gerufen (auth.uid() ist über den
-- Service-Role-Client NULL), bleibt laut 0051 aber bis zum Drop im
-- Folge-PR bestehen — und soll bis dahin nicht hinter der neuen Function
-- zurückfallen. 1:1 aus 0043 plus DELETE prepayment_item_obligations.
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

  DELETE FROM push_subscriptions WHERE person_id = v_person_id;

  DELETE FROM prepayment_reminder_log WHERE person_id = v_person_id;
  DELETE FROM prepayment_obligations WHERE person_id = v_person_id;
  -- 0058
  DELETE FROM prepayment_item_obligations WHERE person_id = v_person_id;

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
     );

  UPDATE persons
     SET display_name = 'Ehemaliges Crew-Mitglied',
         auth_user_id = NULL,
         is_alcoholic = FALSE
   WHERE id = v_person_id;

  RETURN 'ok';
END;
$$;
