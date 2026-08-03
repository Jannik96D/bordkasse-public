-- ═══════════════════════════════════════════════════════════════════════
-- 0046 — credit_to_all: „An Alle" von einer direkten Gutschrift
-- unterscheidbar halten, auch nachdem der Purge (0044) credit_to genullt hat
--
-- Bug (Review-Fund, unabhängige Adversarial-Review): sowohl die App-Logik
-- als auch die UI nutzen `credit_to IS NULL` als Bedeutungsträger für
-- „An Alle" (siehe lib/queries/transactions.ts, transactions-list.tsx,
-- [txId]/page.tsx). Migration 0044 nullt aber JEDE Gutschrift-Zeile beim
-- Purge (auch DIREKTE Gutschriften), um den Empfänger zu anonymisieren.
-- Ohne eigenes Flag würde eine anonymisierte DIREKTE Gutschrift nach dem
-- Purge fälschlich als „An Alle" angezeigt — das ist keine Anonymisierung
-- mehr, sondern eine inhaltliche Verfälschung der Buchung.
--
-- Fix: eigene, vom Personenbezug unabhängige Spalte credit_to_all, die den
-- Purge unverändert übersteht (0044 rührt sie nicht an).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS credit_to_all BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill für bestehende Gutschriften: „An Alle" war bisher ausschließlich
-- über credit_to IS NULL kodiert.
UPDATE transactions SET credit_to_all = TRUE WHERE type = 'credit' AND credit_to IS NULL;
