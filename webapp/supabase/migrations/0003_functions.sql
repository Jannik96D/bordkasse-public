-- ═══════════════════════════════════════════════════════════════════════
-- 0003_functions — simplify_debts() Greedy-Algorithmus
--
-- Spec: docs/calculation-rules.md §Schulden-Vereinfachung
-- Liefert minimale Überweisungs-Liste um alle Salden auszugleichen.
-- Bei N Personen sind maximal N-1 Überweisungen nötig.
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
  -- 1. Schuldner und Gläubiger getrennt sammeln, sortiert absteigend
  SELECT COALESCE(jsonb_agg(d ORDER BY (d->>'open')::NUMERIC DESC), '[]'::JSONB)
  INTO debtors
  FROM (
    SELECT jsonb_build_object(
      'id',   b.person_id,
      'name', p.display_name,
      'open', ROUND(-b.balance, 2)
    ) AS d
    FROM v_balances b
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
    FROM v_balances b
    JOIN persons p ON p.id = b.person_id
    WHERE b.trip_id = p_trip_id AND b.balance > 0.005
  ) sub;

  -- 2. Greedy-Loop mit zwei Zeigern
  WHILE s_idx < jsonb_array_length(debtors) AND g_idx < jsonb_array_length(creditors) LOOP
    s_id   := (debtors  -> s_idx ->> 'id')::UUID;
    s_name :=  debtors  -> s_idx ->> 'name';
    s_open := (debtors  -> s_idx ->> 'open')::NUMERIC;
    g_id   := (creditors -> g_idx ->> 'id')::UUID;
    g_name :=  creditors -> g_idx ->> 'name';
    g_open := (creditors -> g_idx ->> 'open')::NUMERIC;

    pay_amount := ROUND(LEAST(s_open, g_open), 2);

    IF pay_amount > 0 THEN
      from_person_id := s_id;
      from_name      := s_name;
      to_person_id   := g_id;
      to_name        := g_name;
      amount         := pay_amount;
      RETURN NEXT;
    END IF;

    -- Offene Beträge im Array updaten
    debtors   := jsonb_set(debtors,   ARRAY[s_idx::TEXT, 'open'], to_jsonb(s_open - pay_amount));
    creditors := jsonb_set(creditors, ARRAY[g_idx::TEXT, 'open'], to_jsonb(g_open - pay_amount));

    IF (s_open - pay_amount) < 0.005 THEN
      s_idx := s_idx + 1;
    END IF;
    IF (g_open - pay_amount) < 0.005 THEN
      g_idx := g_idx + 1;
    END IF;
  END LOOP;
END;
$$;


-- ── Helper: ist auth.uid() Mitglied dieses Trips? (für RLS) ────────────
CREATE OR REPLACE FUNCTION is_trip_member(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM trip_members tm
    JOIN persons p ON p.id = tm.person_id
    WHERE tm.trip_id = p_trip_id
      AND p.auth_user_id = auth.uid()
  );
$$;


-- ── Helper: ist auth.uid() Skipper dieses Trips? ───────────────────────
CREATE OR REPLACE FUNCTION is_trip_skipper(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM trips t
    JOIN persons p ON p.id = t.skipper_id
    WHERE t.id = p_trip_id
      AND p.auth_user_id = auth.uid()
  );
$$;


-- ── Helper: persons-Row für aktuell eingeloggten Auth-User (oder NULL) ──
CREATE OR REPLACE FUNCTION current_person_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM persons WHERE auth_user_id = auth.uid() LIMIT 1;
$$;
