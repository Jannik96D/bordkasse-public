-- ═══════════════════════════════════════════════════════════════════════
-- 0060 — move_item_payee: Empfängerwechsel nur ohne fremde Zahlungen
--
-- Nachtrag zu 0059 (Review zu PR 271, Funde H1/M5 + Delta-Review Punkt 6).
-- 0059 und 0060 sind zum Zeitpunkt des Schreibens NICHT auf Produktion; die
-- Signatur wird deshalb ersetzt (DROP + CREATE) statt nur ergänzt.
--
-- Neu:
--   • dritter Parameter `p_move_credits BOOLEAN DEFAULT FALSE`. Ohne ihn
--     (saveItem) scheitert der Wechsel mit `prepayment_item_payee_has_credits`,
--     sobald eine lebende Posten-Gutschrift (bestätigt ODER offen, inkl.
--     Selbstverrechnung) existiert — dieselbe Regel wie im App-Check
--     (Entscheidung H1), jetzt auch gegen das Race zwischen App-Check und
--     Aufruf (der Posten ist FOR UPDATE gesperrt, Posten-Gutschriften lesen
--     ihn FOR SHARE). NUR der Ghost-Merge (gleiche Person) ruft mit TRUE und
--     nimmt die Gutschriften mit.
--   • Fehler `prepayment_item_provider_paid_by_other`, wenn eine lebende
--     Anbieter-Zahlung (Ausgabe mit item_id) existiert, die NICHT der neue
--     Empfänger geleistet hat. Der Ghost-Merge hängt paid_by vorher um.
-- Rechte wie 0059: EXECUTE nur service_role, SECURITY INVOKER, search_path
-- gepinnt.
--
-- ⚠️ DEPLOY: 0058 → 0059 → 0060 auf Produktion, DANN App-Merge, danach
-- `NOTIFY pgrst, 'reload schema';`.
--
-- Test: supabase/tests/move_item_payee_test.sql
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS move_item_payee(UUID, UUID);

CREATE OR REPLACE FUNCTION move_item_payee(p_item_id UUID, p_new_payee UUID, p_move_credits BOOLEAN DEFAULT FALSE)
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

  -- 0060 (Delta-Review 6): Gutschriften wandern nur, wenn ausdrücklich
  -- gewünscht (Ghost-Merge). Sonst verbärge der Wechsel eine echte Schuld
  -- zwischen altem und neuem Empfänger (Entscheidung H1).
  IF NOT COALESCE(p_move_credits, FALSE) AND EXISTS (
    SELECT 1 FROM transactions
     WHERE item_id = p_item_id
       AND type = 'credit'
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'prepayment_item_payee_has_credits' USING ERRCODE = 'P0001';
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

REVOKE ALL ON FUNCTION move_item_payee(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION move_item_payee(UUID, UUID, BOOLEAN) TO service_role;
