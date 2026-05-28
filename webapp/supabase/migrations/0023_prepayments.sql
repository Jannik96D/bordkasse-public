-- ═══════════════════════════════════════════════════════════════════════
-- 0023_prepayments — Anzahlungs-Tranchen (Phase 1)
--
-- Modul für Vorab-Zahlungen der Crew an den Skipper (Yacht-Charter):
--   - Soll-Beträge pro Person (gleichmäßig / zeitanteilig / individuell / kojen)
--   - Zeitliche Aufteilung in Tranchen
--   - Eingangs-Erfassung als reguläre Gutschriften mit tranche_id-Tag
--   - Trennung Anzahlungs-Pool ↔ Bordkasse-Pool
--
-- Spec: docs/prepayments.md
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Enum für Aufteilungs-Methode des Plans ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prepayment_split_method') THEN
    CREATE TYPE prepayment_split_method AS ENUM (
      'gleichmaessig',
      'zeitanteilig',
      'individuell',
      'kojen'
    );
  END IF;
END $$;


-- ── 2. prepayment_plan: Konfiguration pro Trip ────────────────────────
-- 1:1 zu trips. Wird beim Wizard-Speichern angelegt; ohne Plan kein Pool.
CREATE TABLE IF NOT EXISTS prepayment_plan (
  trip_id            UUID PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  split_method       prepayment_split_method NOT NULL,
  total_amount       NUMERIC(10,2) NOT NULL,
  wero_id            TEXT,
  whatsapp_template  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pp_total_pos CHECK (total_amount >= 0)
);


-- ── 3. cabin_types: Kojen-Typen pro Trip (nur bei split_method='kojen') ─
CREATE TABLE IF NOT EXISTS cabin_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  price_per_person  NUMERIC(10,2) NOT NULL,
  capacity          INT NOT NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ct_price_nonneg CHECK (price_per_person >= 0),
  CONSTRAINT ct_capacity_pos CHECK (capacity > 0)
);

CREATE INDEX IF NOT EXISTS idx_cabin_types_trip ON cabin_types(trip_id);


-- ── 4. prepayment_obligations: Soll pro Person ────────────────────────
-- total_amount = Gesamt-Soll der Person über alle Tranchen.
-- Pro-Tranche-Soll = total_amount × tranche.percent / 100 (im Render-Pfad).
CREATE TABLE IF NOT EXISTS prepayment_obligations (
  trip_id        UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id      UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  cabin_type_id  UUID NULL REFERENCES cabin_types(id) ON DELETE SET NULL,
  total_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (trip_id, person_id),
  CONSTRAINT po_total_nonneg CHECK (total_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_obligations_trip ON prepayment_obligations(trip_id);
CREATE INDEX IF NOT EXISTS idx_obligations_person ON prepayment_obligations(person_id);


-- ── 5. prepayment_tranches: Zeitliche Aufteilung ──────────────────────
CREATE TABLE IF NOT EXISTS prepayment_tranches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  due_date           DATE NOT NULL,
  label              TEXT NOT NULL,
  percent            NUMERIC(5,2) NOT NULL,
  wero_request_link  TEXT,
  sort_order         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tr_percent_range CHECK (percent > 0 AND percent <= 100)
);

CREATE INDEX IF NOT EXISTS idx_tranches_trip ON prepayment_tranches(trip_id);


-- ── 6. transactions.tranche_id ────────────────────────────────────────
-- Markiert Buchungen als Teil des Anzahlungs-Pools.
-- NULL = Bordkasse-Pool (Default), nicht-NULL = Anzahlungs-Pool.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS tranche_id UUID NULL
  REFERENCES prepayment_tranches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_tranche ON transactions(tranche_id);


-- ── 7. RLS aktivieren + Policies ──────────────────────────────────────
ALTER TABLE prepayment_plan         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cabin_types             ENABLE ROW LEVEL SECURITY;
ALTER TABLE prepayment_obligations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE prepayment_tranches     ENABLE ROW LEVEL SECURITY;


-- prepayment_plan: alle Member lesen, nur Skipper schreiben
CREATE POLICY "pp_select_member"
  ON prepayment_plan FOR SELECT TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "pp_cud_skipper"
  ON prepayment_plan FOR ALL TO authenticated
  USING (is_trip_skipper(trip_id))
  WITH CHECK (is_trip_skipper(trip_id));


-- cabin_types: alle Member lesen, nur Skipper schreiben
CREATE POLICY "ct_select_member"
  ON cabin_types FOR SELECT TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "ct_cud_skipper"
  ON cabin_types FOR ALL TO authenticated
  USING (is_trip_skipper(trip_id))
  WITH CHECK (is_trip_skipper(trip_id));


-- prepayment_obligations:
-- Self-Read (eigene Zeile) + Skipper-Read (kompletter Trip).
-- Schreiben nur Skipper.
CREATE POLICY "po_select_self_or_skipper"
  ON prepayment_obligations FOR SELECT TO authenticated
  USING (
    is_trip_skipper(trip_id)
    OR person_id = current_person_id()
  );

CREATE POLICY "po_cud_skipper"
  ON prepayment_obligations FOR ALL TO authenticated
  USING (is_trip_skipper(trip_id))
  WITH CHECK (is_trip_skipper(trip_id));


-- prepayment_tranches: alle Member lesen, nur Skipper schreiben
CREATE POLICY "tr_select_member"
  ON prepayment_tranches FOR SELECT TO authenticated
  USING (is_trip_member(trip_id) OR is_trip_skipper(trip_id));

CREATE POLICY "tr_cud_skipper"
  ON prepayment_tranches FOR ALL TO authenticated
  USING (is_trip_skipper(trip_id))
  WITH CHECK (is_trip_skipper(trip_id));


-- ── 8. Realtime ───────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE prepayment_plan;
ALTER PUBLICATION supabase_realtime ADD TABLE prepayment_obligations;
ALTER PUBLICATION supabase_realtime ADD TABLE prepayment_tranches;
ALTER PUBLICATION supabase_realtime ADD TABLE cabin_types;


-- ── 9. updated_at-Trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER pp_set_updated_at
  BEFORE UPDATE ON prepayment_plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER po_set_updated_at
  BEFORE UPDATE ON prepayment_obligations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 10. View: Anzahlungs-Pool-Salden pro Person + Tranche ─────────────
-- Aggregiert Zahlungen (Gutschriften und Skipper→Charter-Ausgaben) pro
-- (trip_id, person_id, tranche_id). Wird vom UI für die Matrix benutzt.
CREATE OR REPLACE VIEW v_prepayment_payments AS
SELECT
  t.trip_id,
  t.tranche_id,
  t.credit_from AS person_id,
  COALESCE(SUM(t.amount), 0) AS paid_amount
FROM transactions t
WHERE t.tranche_id IS NOT NULL
  AND t.type = 'credit'
  AND t.deleted_at IS NULL
GROUP BY t.trip_id, t.tranche_id, t.credit_from;

GRANT SELECT ON v_prepayment_payments TO authenticated;
