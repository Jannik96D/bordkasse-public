-- ═══════════════════════════════════════════════════════════════════════
-- 0064 — Buchungs-Kategorie an den Törn binden (Sicherheitsrunde 2026-11,
--        Slice 8)
--
-- Befund: transactions.category_id hatte (0001) nur einen einfachen FK auf
-- trip_categories(id). Eine untergeschobene Kategorie-ID aus einem FREMDEN
-- Törn wurde akzeptiert: sie landete beim Purge in trip_statistics, und das
-- Löschen der Kategorie im fremden Törn nullte die eigene Buchung.
--
-- Fix: Composite-FK (category_id, trip_id) → trip_categories(id, trip_id),
-- Muster pi_category_fk (0058). Das Ziel-UNIQUE trip_categories_id_trip_key
-- legt 0058 an (hier idempotent nachgezogen, falls es fehlte).
--   • ON DELETE SET NULL (category_id): wie bisher wird bei Kategorie-
--     Löschung nur die category_id genullt, NIE trip_id (Spaltenliste, PG15+).
--   • MATCH SIMPLE (Default): Buchungen ohne Kategorie (NULL) sind frei.
--   • Soft-gelöschte Buchungen werden mitgeprüft (der FK kennt deleted_at
--     nicht).
--   • Purge: trip_categories bleiben beim Purge erhalten (0044), category_id
--     wird nicht angefasst → unkritisch.
--   • Reihenfolge: neuer FK zuerst NOT VALID, separat VALIDATE (kurzer
--     Lock), erst danach der alte einfache FK entfernt — die Tabelle ist zu
--     keinem Zeitpunkt ungeschützt.
--
-- ⚠️ VORAB auf Prod lesend prüfen (Erwartung: 0 Zeilen). Treffer wären
-- Buchungen mit Fremd-Kategorie; sie ließen VALIDATE scheitern:
--
--   SELECT t.id, t.trip_id, t.category_id, c.trip_id AS category_trip_id
--   FROM transactions t
--   JOIN trip_categories c ON c.id = t.category_id
--   WHERE c.trip_id <> t.trip_id;
--
-- Bei Treffern: category_id dieser Zeilen bewusst auf NULL setzen (oder auf
-- eine Kategorie des eigenen Törns), dann erst die Migration einspielen.
--
-- Tests: supabase/tests/transaction_category_same_trip_test.sql
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_categories_id_trip_key') THEN
    ALTER TABLE trip_categories
      ADD CONSTRAINT trip_categories_id_trip_key UNIQUE (id, trip_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tx_category_fk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT tx_category_fk FOREIGN KEY (category_id, trip_id)
      REFERENCES trip_categories(id, trip_id) ON DELETE SET NULL (category_id)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE transactions VALIDATE CONSTRAINT tx_category_fk;

-- Alten einfachen FK (auto-benannt transactions_category_id_fkey) entfernen.
-- Per Katalog gesucht statt per festem Namen: einspaltig, auf trip_categories.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'transactions'::regclass
      AND c.confrelid = 'trip_categories'::regclass
      AND c.contype = 'f'
      AND c.conname <> 'tx_category_fk'
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
