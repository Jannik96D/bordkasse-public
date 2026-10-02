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
--   5b. Empfänger-Schutz: Posten-Gutschrift nur an den Posten-Empfänger,
--      kein Empfängerwechsel bei hängenden Gutschriften (Trigger, Fund M3)
--   6. v_balances_bordkasse_only     schließt Posten-Buchungen aus
--      (→ simplify_debts/all_debts_settled bleiben Bordkasse-only, ohne
--      eigene Änderung; v_balances bleibt unverändert die Gesamtbilanz)
--   7. v_prepayment_item_payments / v_prepayment_item_pending
--   8.–10. purge_trip_data / admin_delete_person_data / delete_my_account
--      räumen die neuen Tabellen mit ab (DSGVO); die beiden Konto-Löschungen
--      blocken einen Posten-Empfänger in einem laufenden Törn
--      (`is_active_item_payee`, Review-Fund M1)
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
-- Danach den PostgREST-Schemacache neu laden (`NOTIFY pgrst, 'reload
-- schema';`), falls der Stack keinen pgrst_ddl_watch-Event-Trigger hat —
-- sonst kennt die REST-API die neuen Tabellen/die Spalte bis zum Neustart
-- nicht.
--
-- ⚠️ VORAB-PRÜFUNG (lesend, vor dem Einspielen auf Produktion):
--   select trip_id, count(*) from transactions
--    where type = 'credit' and confirmed_at is null
--      and tranche_id is null and deleted_at is null
--    group by 1;
-- Hintergrund: v_balances_bordkasse_only zählt unbestätigte Gutschriften ab
-- jetzt nicht mehr (Abschnitt 6). Liefert die Abfrage Zeilen (verwaiste
-- Selbstmeldungen, deren Tranche gelöscht wurde), ändert sich für diese
-- Törns sofort die Bordkasse-Bilanz → simplify_debts liefert andere
-- Überweisungen → bereits gesetzte Häkchen in settled_debts (Schlüssel
-- from/to/amount) passen evtl. nicht mehr und erscheinen wieder offen →
-- all_debts_settled kann kippen (Purge-Gate; in beide Richtungen). Bei
-- abgerechneten Törns die Crew informieren bzw. die Zeile vorher bewusst
-- bestätigen oder soft-löschen. Leeres Ergebnis = keine Auswirkung.
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
  -- die Gutschriften zustehen. Personen werden vom Purge-Orphan-Cleanup
  -- (unten abgesichert) und schon HEUTE vom Ghost-Merge
  -- (mergeGhostIntoExistingPerson) hart gelöscht — ist ein Ghost Empfänger,
  -- scheiterte der Merge an RESTRICT; seit PR4a hängt der Merge den
  -- Empfänger vorher über move_item_payee (Migration 0059) um.
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

-- Eine Posten-Gutschrift hat immer einen konkreten Empfänger (den
-- Posten-Empfänger bzw. bei der Selbstverrechnung ihn selbst). „An Alle"
-- (credit_to NULL) würde v_balances auf die ganze Crew verteilen — für
-- einen Posten sinnlos. Der Purge nullt credit_to und item_id im SELBEN
-- UPDATE, der Check bleibt dort erfüllt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tx_item_credit_direct') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT tx_item_credit_direct CHECK (
        item_id IS NULL OR type <> 'credit' OR credit_to IS NOT NULL
      );
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
-- per CASCADE ohnehin mit, es gibt nichts zu schützen. Die Reihenfolge der
-- CASCADE-Trigger auf trips hängt an OIDs (sortiert nach Triggername) und
-- kann nach Dump/Restore kippen; der Test erzwingt deshalb die ungünstige
-- Reihenfolge. Der Purge läuft NICHT an diesem Trigger vorbei, er
-- entkoppelt vorher selbst (`item_id = NULL` im anonymisierenden UPDATE).
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

-- Reine Hygiene: eine Trigger-Funktion ist nicht direkt aufrufbar, und
-- EXECUTE wird beim Feuern nicht geprüft.
REVOKE ALL ON FUNCTION prepayment_item_guard_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pi_guard_delete ON prepayment_items;
CREATE TRIGGER pi_guard_delete
  BEFORE DELETE ON prepayment_items
  FOR EACH ROW EXECUTE FUNCTION prepayment_item_guard_delete();


-- ── 5b. Posten-Gutschrift nur an den Posten-Empfänger (Review-Fund M3) ───
-- v_prepayment_item_payments zählt nach `credit_from`. Ohne diese Regel
-- würde jede Gutschrift mit item_id als „bezahlt" zählen, egal an wen sie
-- geht — z. B. eine Selbstverrechnung B→B eines Crewmitglieds (tx_credit_self
-- erlaubt A→A bei item_id) oder B→C an eine dritte Person. Die App (PR4)
-- setzt credit_to auf den Empfänger; das hier ist Defense in Depth.
--
-- Trigger statt Join in der View: die Regel verhindert die falsche Zeile,
-- statt sie nur auszublenden — eine B→C-Gutschrift mit item_id würde sonst
-- weiter in v_balances wirken, aber in keinem Topf als Zahlung erscheinen.
--
-- Ausnahmen (bewusst):
--   • credit_to NULL → tx_item_credit_direct ist zuständig (eigene, klarere
--     Fehlermeldung 23514); der Purge nullt credit_to und item_id zusammen.
--   • deleted_at gesetzt → wirkt nirgends (Reject einer Selbstmeldung =
--     Soft-Delete). Ein Zurückholen (deleted_at → NULL) prüft erneut.
--   • Posten nicht gefunden → der Composite-FK tx_item_fk meldet das (23503).
-- Spaltenliste beim UPDATE: nur die Spalten, die die Regel berühren. Ein
-- Umhängen von credit_from (Ghost-Merge) feuert nicht.
--
-- Die Gegenseite (Grill-Fund): ein nachträglicher Wechsel von
-- prepayment_items.payee_person_id ließe alle bisherigen Gutschriften mit
-- dem ALTEN Empfänger zurück — sie zählten weiter als „bezahlt", obwohl sie
-- die Regel jetzt verletzen. Deshalb blockt `pi_guard_payee_change` einen
-- Empfängerwechsel, solange noch eine nicht gelöschte Gutschrift (auch
-- pending — deren Bestätigung ändert nur confirmed_at und feuert diesen
-- Trigger nicht) am Posten hängt. Kontrollierter Wechsel samt credit_to
-- seit PR4a über move_item_payee (Migration 0059, transaktionslokales Flag;
-- Altzahlungen wandern zum neuen Empfänger). replaceMember lehnt einen
-- Empfänger dagegen ab (Payee-Guard).
--
-- `FOR SHARE` auf die Posten-Zeile: ein gleichzeitiger Empfängerwechsel
-- wartet, bis diese Buchung committet ist, und sieht sie dann in seinem
-- Guard (sonst Race unter READ COMMITTED).
-- SECURITY DEFINER: die Prüfung soll den Posten unabhängig von der RLS des
-- Aufrufers sehen.
CREATE OR REPLACE FUNCTION transactions_item_credit_payee_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payee UUID;
BEGIN
  IF NEW.type <> 'credit'
     OR NEW.item_id IS NULL
     OR NEW.credit_to IS NULL
     OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT payee_person_id INTO v_payee
    FROM prepayment_items
   WHERE id = NEW.item_id AND trip_id = NEW.trip_id
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.credit_to <> v_payee THEN
    RAISE EXCEPTION 'prepayment_item_credit_wrong_payee'
      USING ERRCODE = 'P0001',
            DETAIL = 'Eine Posten-Gutschrift muss an den Empfänger des Postens gehen.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION transactions_item_credit_payee_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tx_item_credit_payee ON transactions;
CREATE TRIGGER tx_item_credit_payee
  BEFORE INSERT OR UPDATE OF type, trip_id, item_id, credit_to, deleted_at ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_item_credit_payee_guard();

CREATE OR REPLACE FUNCTION prepayment_item_guard_payee_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.payee_person_id IS DISTINCT FROM OLD.payee_person_id
     AND EXISTS (
       SELECT 1 FROM transactions
        WHERE item_id = OLD.id
          AND type = 'credit'
          AND deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION 'prepayment_item_payee_has_credits'
      USING ERRCODE = 'P0001',
            DETAIL = 'Der Empfänger eines Postens kann nicht wechseln, solange Gutschriften an ihn hängen.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION prepayment_item_guard_payee_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pi_guard_payee_change ON prepayment_items;
CREATE TRIGGER pi_guard_payee_change
  BEFORE UPDATE OF payee_person_id ON prepayment_items
  FOR EACH ROW EXECUTE FUNCTION prepayment_item_guard_payee_change();


-- ── 6. v_balances_bordkasse_only ohne Posten-Buchungen ───────────────────
-- 1:1 aus 0042, zwei Änderungen in bordkasse_tx:
--   • `AND item_id IS NULL` — simplify_debts (0027/0055) liest diese View →
--     Posten erzeugen keine Überweisungen im Schulden-Tab (wie die Charter).
--     v_balances bleibt die Gesamtbilanz über alle drei Töpfe.
--   • unbestätigte Gutschriften zählen nicht (Gürtel, Grill-Fund) — exakt
--     wie in v_balances seit 0043. 0042 verließ sich darauf, dass es Pending
--     nur mit tranche_id gibt; löscht saveTranches aber eine Tranche mit
--     offener Selbstmeldung, nullt der FK die tranche_id und die Meldung
--     wurde hier zur echten Bordkasse-Gutschrift (Phantom-Überweisung,
--     all_debts_settled blockiert den Purge). Ausgaben sind immer bestätigt
--     (confirmed_at DEFAULT now(), Bestand in 0025 backgefüllt) und bleiben
--     ungefiltert, wie in v_balances.
CREATE OR REPLACE VIEW v_balances_bordkasse_only AS
WITH bordkasse_tx AS (
  SELECT *
  FROM transactions
  WHERE tranche_id IS NULL
    AND item_id IS NULL
    AND deleted_at IS NULL
    AND (type <> 'credit' OR confirmed_at IS NOT NULL)
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
-- 1:1 aus 0051, drei Änderungen (markiert mit „0058"):
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


-- ── 10. delete_my_account (Altpfad, 0043) parallel nachziehen ────────────
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
