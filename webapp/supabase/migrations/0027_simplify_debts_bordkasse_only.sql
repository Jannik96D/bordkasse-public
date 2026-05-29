-- ═══════════════════════════════════════════════════════════════════════
-- 0027_simplify_debts_bordkasse_only — Schulden basieren nur auf Bordkasse
--
-- Bug-Fix: bisher las simplify_debts() aus v_balances, die alle
-- Buchungen aggregiert (inkl. Anzahlungs-Pool). Wenn der Skipper z.B. die
-- Yacht-Buchung ohne tranche_id als „Gleichmäßig"-Ausgabe erfasste,
-- bekam jede Crew einen Yacht-Anteil in der Bordkasse zugewiesen — UND
-- gleichzeitig wurden die Crew-Anzahlungen im Anzahlungs-Pool verbucht.
-- Doppelte Verbuchung führte zu Phantom-Schulden im Schulden-Tab.
--
-- Lösung: simplify_debts liest jetzt aus v_balances_bordkasse_only
-- (Migration 0026, filtered auf tranche_id IS NULL). Das Anzahlungs-Pool
-- wird komplett über die Anzahlungs-Matrix verwaltet, die Schulden-
-- Übersicht zeigt nur Bordkasse-Schulden (laufende Trip-Kosten).
--
-- Konsequenz für Settlement: Bezahlt-Häkchen + Settlement-Mail beziehen
-- sich auf Bordkasse-Schulden. Anzahlungs-Offenheiten müssen vor Trip-
-- Start abgeschlossen sein und werden separat über die Matrix verwaltet.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION simplify_debts(p_trip_id UUID)
RETURNS TABLE (
  from_person_id  UUID,
  from_name       TEXT,
  to_person_id    UUID,
  to_name         TEXT,
  amount          NUMERIC(10, 2)
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  debtors    JSONB := '[]'::JSONB;
  creditors  JSONB := '[]'::JSONB;
  s_idx      INT := 0;
  g_idx      INT := 0;
  s_open     NUMERIC(12, 4);
  g_open     NUMERIC(12, 4);
  s_id       UUID;
  s_name     TEXT;
  g_id       UUID;
  g_name     TEXT;
  pay_amount NUMERIC(10, 2);
BEGIN
  -- 1. Schuldner und Gläubiger getrennt sammeln, sortiert absteigend.
  --    Aus v_balances_bordkasse_only (nur transactions WHERE tranche_id IS NULL).
  SELECT COALESCE(jsonb_agg(d ORDER BY (d->>'open')::NUMERIC DESC), '[]'::JSONB)
  INTO debtors
  FROM (
    SELECT jsonb_build_object(
      'id',   b.person_id,
      'name', p.display_name,
      'open', ROUND(-b.balance, 2)
    ) AS d
    FROM v_balances_bordkasse_only b
    JOIN persons p ON p.id = b.person_id
    WHERE b.trip_id = p_trip_id AND b.balance < -0.005
  ) sub;

  SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'open')::NUMERIC DESC), '[]'::JSONB)
  INTO creditors
  FROM (
    SELECT jsonb_build_object(
      'id',   b.person_id,
      'name', p.display_name,
      'open', ROUND(b.balance, 2)
    ) AS c
    FROM v_balances_bordkasse_only b
    JOIN persons p ON p.id = b.person_id
    WHERE b.trip_id = p_trip_id AND b.balance > 0.005
  ) sub;

  -- 2. Greedy-Matching: größter Schuldner zahlt an größten Gläubiger
  WHILE s_idx < jsonb_array_length(debtors) AND g_idx < jsonb_array_length(creditors) LOOP
    s_open := (debtors->s_idx->>'open')::NUMERIC;
    g_open := (creditors->g_idx->>'open')::NUMERIC;
    s_id   := (debtors->s_idx->>'id')::UUID;
    s_name := debtors->s_idx->>'name';
    g_id   := (creditors->g_idx->>'id')::UUID;
    g_name := creditors->g_idx->>'name';

    pay_amount := LEAST(s_open, g_open);
    pay_amount := ROUND(pay_amount, 2);

    IF pay_amount > 0.005 THEN
      from_person_id := s_id;
      from_name      := s_name;
      to_person_id   := g_id;
      to_name        := g_name;
      amount         := pay_amount;
      RETURN NEXT;
    END IF;

    s_open := s_open - pay_amount;
    g_open := g_open - pay_amount;
    debtors   := jsonb_set(debtors,   ARRAY[s_idx::TEXT, 'open'], to_jsonb(s_open));
    creditors := jsonb_set(creditors, ARRAY[g_idx::TEXT, 'open'], to_jsonb(g_open));

    IF s_open <= 0.005 THEN s_idx := s_idx + 1; END IF;
    IF g_open <= 0.005 THEN g_idx := g_idx + 1; END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION simplify_debts(UUID) TO authenticated;
