-- ═══════════════════════════════════════════════════════════════════════
-- 0055 — simplify_debts()-Tiebreaker (Sanierungsplan 2026-09, PR 9d, Fund 21)
--
-- Problem: die beiden `jsonb_agg(... ORDER BY (d->>'open')::NUMERIC DESC)`
-- in simplify_debts() (0027) sortieren Schuldner/Gläubiger NUR nach
-- offenem Betrag. Haben zwei Personen exakt denselben Betrag, ist die
-- Reihenfolge zwischen ihnen nicht deterministisch garantiert — Postgres
-- liefert bei ORDER-BY-Gleichstand keine über mehrere Aufrufe stabile
-- Zusatzordnung (abhängig vom zugrundeliegenden Scan, der sich nach
-- ANALYZE/Autovacuum/Planwechsel ändern kann). Analog zur MATCH-Falle der
-- alten Sheets-Lösung (siehe CLAUDE.md „Bekannte Fallen"), nur hier in der
-- SQL-Function statt in Sheets-Formeln.
--
-- Auswirkung: `toggleDebtSettled` validiert `(from, to, amount)` gegen die
-- LIVE neu berechnete Ausgabe von simplify_debts() (Fix S-6, Migration
-- 0027-Nachfolger). Ändert sich bei einem erneuten Aufruf durch Gleichstand
-- die Zuordnung (z. B. A→C statt A→B bei zwei gleich hohen Schuldnern),
-- entwertet das ein bereits gesetztes Bezahlt-Häkchen in `settled_debts`
-- (dort ebenfalls auf (from, to, amount) verschlüsselt, siehe 0009).
--
-- Fix: Person-ID als deterministischer Sekundärschlüssel (aufsteigend) in
-- BEIDEN ORDER-BY-Klauseln (Schuldner UND Gläubiger — nur eine Seite zu
-- fixen wäre unvollständig, die andere Seite könnte weiterhin kippen).
-- `(d->>'id')` ist Text (UUID-Darstellung); Postgres' Standard-Kollation
-- sortiert das byte-/codepointweise, exakt wie der TS-Mirror-Fix in
-- lib/calc/debts.ts (Ordinalvergleich statt localeCompare).
--
-- Rest der Function unverändert 1:1 aus dem Vorgänger (0027) übernommen —
-- CREATE OR REPLACE reicht, kein DROP nötig (Signatur/Rückgabetyp gleich).
--
-- Entscheidung (Nutzer, 2026-09-08): KEINE Datenmigration für bestehende
-- `settled_debts`-Zeilen — aktuell läuft kein Törn, der von einem
-- tatsächlichen Gleichstand betroffen sein könnte (bewusst kein
-- Alt-vs-Neu-Vergleich, kein Cross-Check-Dry-Run vor dem Rollout).
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
  -- 1. Schuldner und Gläubiger getrennt sammeln, sortiert absteigend nach
  --    offenem Betrag, bei Gleichstand aufsteigend nach Person-ID (Fix 0055).
  --    Aus v_balances_bordkasse_only (nur transactions WHERE tranche_id IS NULL).
  SELECT COALESCE(jsonb_agg(d ORDER BY (d->>'open')::NUMERIC DESC, (d->>'id')), '[]'::JSONB)
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

  SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'open')::NUMERIC DESC, (c->>'id')), '[]'::JSONB)
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
