-- ═══════════════════════════════════════════════════════════════════════
-- 0059 — Empfänger eines Reise-Postens wechseln (PR4 / B-b, Server-Logik)
--
-- 0058 schützt die Zuordnung „Posten-Gutschrift geht an den Posten-
-- Empfänger" mit zwei IMMEDIATE-Triggern:
--   • tx_item_credit_payee    — eine Gutschrift mit item_id muss credit_to =
--                               payee_person_id haben;
--   • pi_guard_payee_change   — payee_person_id darf nicht wechseln, solange
--                               eine nicht gelöschte Gutschrift am Posten hängt.
-- Zusammen machen sie einen Empfängerwechsel mit hängenden Gutschriften
-- unmöglich: egal in welcher Reihenfolge man Posten und Gutschriften
-- umhängt, der jeweils erste Schritt verletzt einen der beiden Trigger.
-- Gebraucht wird der Wechsel aber an zwei Stellen:
--   1. Ghost-Merge (trip-members.ts, mergeGhostIntoExistingPerson): ein
--      Ghost ist Empfänger und wird in sein echtes Konto verschmolzen. Ohne
--      Wechsel scheitert der Merge an RESTRICT auf payee_person_id bzw.
--      vorher schon am Umhängen von credit_to (tx_item_credit_payee).
--   2. saveItem: der Skipper trägt bewusst einen anderen Empfänger ein
--      (z. B. weil die Flüge doch jemand anderes bucht).
--
-- FACHLICHE ENTSCHEIDUNG (mit dem Plan abgestimmt, docs/prepayments.md):
-- die bisherigen Gutschriften WANDERN zum neuen Empfänger (credit_to wird
-- umgehängt, auch bei offenen Selbstmeldungen). Wer schon gezahlt hat, hat
-- seinen Anteil damit weiterhin „bezahlt" (v_prepayment_item_payments zählt
-- nach credit_from), und der neue Empfänger ist für die Abwicklung
-- zuständig. Annahme wie beim Crewwechsel: die beiden Empfänger gleichen das
-- bereits eingesammelte Geld untereinander aus — das bildet die App nicht ab.
-- Konsequenzen für Selbstverrechnungen: alter→alter wird zu alter→neuer
-- (der alte Empfänger hat seinen Anteil damit an den neuen „gezahlt"),
-- neuer→alter wird zu neuer→neuer (Selbstverrechnung, per tx_credit_self
-- mit item_id erlaubt). Eine Anbieter-Zahlung (Ausgabe mit item_id,
-- paid_by = alter Empfänger) wird NICHT angefasst — sie hat wirklich der
-- alte Empfänger bezahlt. Deshalb blockt saveItem einen Wechsel, sobald eine
-- solche Ausgabe existiert; der Ghost-Merge hängt paid_by ohnehin selbst um
-- (dieselbe Person).
--
-- UMGEHUNG DES TRIGGERS — gewählte Variante und warum:
--   • Reihenfolge: erst payee_person_id, dann credit_to. Danach passt jede
--     umgehängte Gutschrift zum (neuen) Empfänger, tx_item_credit_payee
--     greift also ganz normal und muss NICHT umgangen werden. Nur
--     pi_guard_payee_change braucht eine Ausnahme.
--   • Die Ausnahme ist ein TRANSAKTIONSLOKALES Flag
--     (`set_config('bordkasse.item_payee_move', <item_id>, true)`), das der
--     Trigger nur für GENAU DIESEN Posten akzeptiert. Es lebt nur bis zum
--     Ende der Transaktion (PostgREST führt jeden RPC-Aufruf in einer eigenen
--     Transaktion aus) und wird direkt nach dem Update wieder geleert.
--   • Verworfen: `session_replication_role = replica` (schaltet ALLE Trigger
--     und FK-Prüfungen ab, braucht Superuser), `ALTER TABLE … DISABLE
--     TRIGGER` (Owner-Recht, ACCESS EXCLUSIVE-Lock, wirkt für alle parallelen
--     Sitzungen), Löschen+Neuanlegen der Gutschriften (verliert IDs,
--     idempotency_keys und Audit-Bezug).
--   • Ein Angreifer kann das Flag nicht setzen: PostgREST bietet keinen Weg,
--     beliebige GUCs zu setzen, und `authenticated`/`anon` haben ohnehin
--     keine Schreibrechte auf prepayment_items (0058, Abschnitt 3).
--   • Zum Schluss prüft die Funktion die Invariante selbst (jede lebende
--     Gutschrift des Postens geht an den neuen Empfänger) und bricht sonst
--     die ganze Transaktion ab.
--
-- SECURITY INVOKER (nicht DEFINER): die Funktion braucht keine erhöhten
-- Rechte — sie wird ausschließlich vom Service-Role-Client gerufen, der die
-- Tabellen ohnehin schreiben darf. EXECUTE nur für service_role (Lehre aus
-- 0049: CREATE FUNCTION vergibt EXECUTE implizit an PUBLIC).
-- Kein Mitgliedschafts-Check in SQL: beim Ghost-Merge ist die echte Person
-- zum Zeitpunkt des Wechsels noch nicht Crew (trip_members wird erst danach
-- umgehängt). Die Prüfung „Empfänger ist Crew dieses Törns" macht saveItem
-- im App-Layer (personsBelongToTrip).
--
-- Additiv: neue Funktion + die 0058-Triggerfunktion mit einer zusätzlichen
-- Frühausstiegs-Bedingung (ohne gesetztes Flag exakt das alte Verhalten).
--
-- ⚠️ DEPLOY-REIHENFOLGE: diese Migration VOR dem App-Merge auf Produktion
-- einspielen (Coolify deployt beim Merge sofort). Ohne sie scheitern
-- Empfängerwechsel und Ghost-Merge eines Empfängers mit „function
-- move_item_payee does not exist" (sauber abgefangen, aber funktionslos).
-- Danach ggf. `NOTIFY pgrst, 'reload schema';`.
--
-- Test: supabase/tests/move_item_payee_test.sql
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. pi_guard_payee_change: Ausnahme für move_item_payee ──────────────
-- 1:1 aus 0058 plus der Flag-Abfrage. `current_setting(…, true)` liefert
-- NULL, wenn das Flag nie gesetzt wurde → Vergleich NULL → keine Ausnahme.
CREATE OR REPLACE FUNCTION prepayment_item_guard_payee_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- 0059: kontrollierter Wechsel über move_item_payee (nur für diesen Posten).
  IF current_setting('bordkasse.item_payee_move', true) = OLD.id::text THEN
    RETURN NEW;
  END IF;

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


-- ── 2. move_item_payee ───────────────────────────────────────────────────
-- Rückgabe: Anzahl der umgehängten Gutschriften (0, wenn der Empfänger
-- schon stimmt — idempotent für Retries).
CREATE OR REPLACE FUNCTION move_item_payee(p_item_id UUID, p_new_payee UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_payee UUID;
  v_moved     INTEGER;
BEGIN
  IF p_item_id IS NULL OR p_new_payee IS NULL THEN
    RAISE EXCEPTION 'prepayment_item_payee_invalid' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE: serialisiert gegen parallele Posten-Gutschriften (deren
  -- Trigger liest den Posten FOR SHARE) und parallele Wechsel.
  SELECT payee_person_id INTO v_old_payee
    FROM prepayment_items
   WHERE id = p_item_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepayment_item_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_new_payee) THEN
    RAISE EXCEPTION 'prepayment_item_payee_invalid' USING ERRCODE = 'P0001';
  END IF;

  IF v_old_payee = p_new_payee THEN
    RETURN 0;
  END IF;

  PERFORM set_config('bordkasse.item_payee_move', p_item_id::text, true);
  UPDATE prepayment_items SET payee_person_id = p_new_payee WHERE id = p_item_id;
  PERFORM set_config('bordkasse.item_payee_move', '', true);

  -- Danach passen die Gutschriften zum neuen Empfänger → tx_item_credit_payee
  -- greift regulär. Auch soft-gelöschte Zeilen mitnehmen: ein späteres
  -- Zurückholen soll nicht am Empfänger-Trigger scheitern.
  UPDATE transactions
     SET credit_to = p_new_payee
   WHERE item_id = p_item_id
     AND type = 'credit'
     AND credit_to = v_old_payee;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM transactions
     WHERE item_id = p_item_id
       AND type = 'credit'
       AND deleted_at IS NULL
       AND credit_to IS DISTINCT FROM p_new_payee
  ) THEN
    RAISE EXCEPTION 'prepayment_item_credit_wrong_payee' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION move_item_payee(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION move_item_payee(UUID, UUID) TO service_role;
