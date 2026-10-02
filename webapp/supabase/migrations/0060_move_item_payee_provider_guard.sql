-- ═══════════════════════════════════════════════════════════════════════
-- 0060 — move_item_payee: kein Empfängerwechsel bei fremder Anbieter-Zahlung
--
-- Nachtrag zu 0059 (Review zu PR 271, Funde H1/M5). Additiv: nur
-- CREATE OR REPLACE der Funktion mit einer zusätzlichen Prüfung; Signatur,
-- Rückgabe und Rechte unverändert (REVOKE/GRANT zur Sicherheit wiederholt).
--
-- Neu: Fehler `prepayment_item_provider_paid_by_other` (P0001), wenn eine
-- nicht gelöschte Ausgabe mit dieser item_id existiert, deren paid_by NICHT
-- der neue Empfänger ist. Die App (saveItem) lehnt einen Empfängerwechsel
-- ohnehin ab, sobald Anbieter-Zahlungen oder lebende Posten-Gutschriften
-- existieren (H1) — die SQL-Prüfung schließt das Race zwischen dieser
-- App-Prüfung und dem Aufruf. Ghost-Merge (gleiche Person) hängt paid_by
-- vorher um und ist damit nicht betroffen.
--
-- ⚠️ DEPLOY: 0058 → 0059 → 0060 auf Produktion, DANN App-Merge, danach
-- `NOTIFY pgrst, 'reload schema';`.
--
-- Test: supabase/tests/move_item_payee_test.sql
-- ═══════════════════════════════════════════════════════════════════════

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

  -- 0060 (Review M5/H1): keine lebende Anbieter-Zahlung (Ausgabe mit
  -- item_id), die NICHT der neue Empfänger geleistet hat. Sonst wanderten
  -- die Crew-Rückzahlungen zum neuen Empfänger, während das Geld beim alten
  -- liegt — eine Schuld zwischen den beiden, die kein Schulden-Tab zeigt.
  -- saveItem prüft das schon im App-Layer; hier schließt die Prüfung das
  -- Race zwischen App-Check und Aufruf (der Posten ist oben FOR UPDATE
  -- gesperrt). Der Ghost-Merge hängt paid_by VORHER auf das echte Konto um
  -- und passiert die Prüfung deshalb.
  IF EXISTS (
    SELECT 1 FROM transactions
     WHERE item_id = p_item_id
       AND type = 'expense'
       AND deleted_at IS NULL
       AND paid_by IS DISTINCT FROM p_new_payee
  ) THEN
    RAISE EXCEPTION 'prepayment_item_provider_paid_by_other' USING ERRCODE = 'P0001';
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
