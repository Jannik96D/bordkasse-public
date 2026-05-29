-- ═══════════════════════════════════════════════════════════════════════
-- 0025_self_payment_confirmation — Crew-Selbstmeldung Phase 2
--
-- Crew-Mitglied klickt in seiner Trip-Sicht „Ich habe gezahlt" → es wird
-- eine reguläre Gutschrift erfasst, aber mit `confirmed_at IS NULL`.
-- Skipper sieht das in der Matrix als ⏳ und kann bestätigen (setzt
-- confirmed_at = now()) oder ablehnen (soft-delete via deleted_at).
--
-- Existierende Buchungen aus Phase 1 gelten als bestätigt — Default
-- daher auf now() bei NOT NULL? Nein, Default NULL — wir füllen die
-- Spalte für alte Rows einmalig in der Migration mit created_at, damit
-- sie automatisch als bestätigt gelten.
-- ═══════════════════════════════════════════════════════════════════════

-- DEFAULT now() sorgt dafür, dass alle „klassisch" eingetragenen Buchungen
-- (Skipper-Eingabe, Admin-Eingabe, normaler Crew-Member-Eintrag) automatisch
-- als bestätigt gelten. Nur die Crew-Self-Payment-Action setzt das Feld
-- explizit auf NULL.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL DEFAULT now();

-- Bestehende Rows haben durch das DEFAULT bereits einen Wert (Postgres
-- füllt beim ADD COLUMN mit NOT NULL DEFAULT auf; bei NULL DEFAULT lässt
-- es alte Rows auf NULL). Daher explizit nachziehen für die alten:
UPDATE transactions
  SET confirmed_at = created_at
  WHERE confirmed_at IS NULL
    AND deleted_at IS NULL;

COMMENT ON COLUMN transactions.confirmed_at IS
  'Bei Anzahlungs-Gutschriften (tranche_id IS NOT NULL): Zeitpunkt der '
  'Skipper-Bestätigung. NULL = von Crew selbst gemeldet, noch nicht '
  'bestätigt. Bei normalen Buchungen wird das Feld beim Anlegen direkt '
  'mit now() gefüllt.';


-- ── v_prepayment_payments anpassen ────────────────────────────────────
-- Pending-Zahlungen sollen NICHT zum aggregierten paid_amount zählen —
-- erst nach Bestätigung wird der Soll-Status der Tranche aktualisiert.
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
  AND t.confirmed_at IS NOT NULL
GROUP BY t.trip_id, t.tranche_id, t.credit_from;

GRANT SELECT ON v_prepayment_payments TO authenticated;


-- ── Optional: Pending-View für UI ─────────────────────────────────────
-- Liste der noch-nicht-bestätigten Anzahlungs-Gutschriften pro Trip.
-- Wird im Matrix-Component verwendet, um ⏳-Indikatoren zu rendern.
CREATE OR REPLACE VIEW v_prepayment_pending AS
SELECT
  t.id            AS transaction_id,
  t.trip_id,
  t.tranche_id,
  t.credit_from   AS person_id,
  t.amount,
  t.date,
  t.description,
  t.created_at,
  t.created_by
FROM transactions t
WHERE t.tranche_id IS NOT NULL
  AND t.type = 'credit'
  AND t.deleted_at IS NULL
  AND t.confirmed_at IS NULL;

GRANT SELECT ON v_prepayment_pending TO authenticated;
