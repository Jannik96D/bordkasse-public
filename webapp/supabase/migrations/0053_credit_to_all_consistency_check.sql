-- ═══════════════════════════════════════════════════════════════════════
-- 0053 — CHECK-Constraint für credit_to_all nachtragen (Sanierungsplan
--        2026-09, PR 7 — Purge/DSGVO)
--
-- Migration 0046 hat `transactions.credit_to_all` eingeführt, um „An Alle"
-- unabhängig vom Personenbezug (credit_to) haltbar zu machen — insbesondere
-- damit eine anonymisierte DIREKTE Gutschrift (Purge nullt credit_to IMMER)
-- nach dem Purge nicht fälschlich als „An Alle" erscheint. Der dazugehörige
-- CHECK, der die Kombination `credit_to_all = TRUE` UND `credit_to IS NOT
-- NULL` verhindert, wurde damals versehentlich vergessen.
--
-- Analyse vor dem Nachtragen (keine bestehende Zeile kann verletzen):
--   - App-seitig wird credit_to_all ausschließlich als
--     `credit_to_all: parsed.data.credit_to == null` gesetzt
--     (lib/actions/transactions.ts, drei Call-Sites: createCredit,
--     updateCredit, Outbox-Replay-Credit) — credit_to_all ist also per
--     Konstruktion NIE true, während credit_to zugleich gesetzt ist.
--   - purge_trip_data nullt credit_to, rührt credit_to_all NICHT an: eine
--     vormals direkte Gutschrift (credit_to_all = FALSE) hat danach
--     credit_to_all = FALSE UND credit_to = NULL → Constraint erfüllt,
--     weil `NOT credit_to_all` bereits TRUE ist.
--   - Eine „An Alle"-Gutschrift (credit_to_all = TRUE, credit_to war von
--     Anfang an NULL) bleibt nach dem Purge unverändert bei credit_to =
--     NULL → Constraint erfüllt, weil `credit_to IS NULL` TRUE ist.
--   - Backfill-UPDATE in 0046 selbst setzte credit_to_all nur für Zeilen
--     mit credit_to IS NULL — verletzt den Constraint ebenfalls nicht.
--
-- Es gibt also keinen Schreibpfad (App-Layer oder bisherige Migrationen),
-- der eine verletzende Kombination erzeugen konnte — NOT VALID + separates
-- VALIDATE ist damit reine Vorsicht (kurzer Lock, kein Full-Table-Scan-
-- Risiko bei ungünstigem Timing), nicht weil ein Verstoß erwartet wird.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE transactions
  ADD CONSTRAINT tx_credit_to_all_consistency
  CHECK (NOT credit_to_all OR credit_to IS NULL) NOT VALID;

ALTER TABLE transactions
  VALIDATE CONSTRAINT tx_credit_to_all_consistency;
