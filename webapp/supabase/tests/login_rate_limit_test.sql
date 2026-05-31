-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Login-Rate-Limit (Migration 0036_login_rate_limit)
--
-- Wächter für bump_login_rate_limit(): Fixed-Window-Counter, der die
-- Magic-Link-Anforderungen pro Schlüssel (E-Mail/IP) begrenzt. Schützt den
-- Login-Endpoint gegen Flutung (Mailbombing / Auth-Mail-Kontingent).
--
-- Geprüft: erlaubt bis zur Schwelle, dann geblockt; Schlüssel sind isoliert;
-- Fenster-Reset zählt neu an; cleanup_login_rate_limit() räumt alte Zeilen.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(11);

-- ── max = 3 in 15-Min-Fenster: die ersten 3 Versuche sind erlaubt ──────
SELECT ok(     bump_login_rate_limit('pgtap:e', 3, 900),  'Versuch 1 erlaubt');
SELECT ok(     bump_login_rate_limit('pgtap:e', 3, 900),  'Versuch 2 erlaubt');
SELECT ok(     bump_login_rate_limit('pgtap:e', 3, 900),  'Versuch 3 erlaubt');

-- ── ab dem 4. Versuch geblockt (false) ────────────────────────────────
SELECT ok(NOT bump_login_rate_limit('pgtap:e', 3, 900),   'Versuch 4 geblockt');
SELECT ok(NOT bump_login_rate_limit('pgtap:e', 3, 900),   'Versuch 5 weiter geblockt');

SELECT is(
  (SELECT attempts FROM login_rate_limit WHERE key = 'pgtap:e'),
  5::int, 'Zähler steht nach 5 Versuchen bei 5');

-- ── Schlüssel sind voneinander unabhängig ─────────────────────────────
SELECT ok(bump_login_rate_limit('pgtap:other', 3, 900), 'fremder Schlüssel unabhängig erlaubt');

-- ── Fenster abgelaufen → Zähler startet neu ───────────────────────────
UPDATE login_rate_limit SET window_start = now() - interval '20 minutes'
WHERE key = 'pgtap:e';

SELECT ok(bump_login_rate_limit('pgtap:e', 3, 900), 'nach Fensterablauf wieder erlaubt');
SELECT is(
  (SELECT attempts FROM login_rate_limit WHERE key = 'pgtap:e'),
  1::int, 'Zähler nach Fenster-Reset = 1');

-- ── cleanup_login_rate_limit() entfernt nur >1 Tag alte Zeilen ─────────
INSERT INTO login_rate_limit(key, window_start, attempts) VALUES
  ('pgtap:old',   now() - interval '2 days', 1),
  ('pgtap:fresh', now(),                     1);
SELECT cleanup_login_rate_limit();

SELECT is(
  (SELECT count(*) FROM login_rate_limit WHERE key = 'pgtap:old'),
  0::bigint, 'cleanup entfernt die über 1 Tag alte Zeile');
SELECT is(
  (SELECT count(*) FROM login_rate_limit WHERE key = 'pgtap:fresh'),
  1::bigint, 'cleanup lässt die frische Zeile stehen');

SELECT * FROM finish();
ROLLBACK;
