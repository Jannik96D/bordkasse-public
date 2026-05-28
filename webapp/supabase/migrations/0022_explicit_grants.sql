-- ═══════════════════════════════════════════════════════════════════════
-- 0022_explicit_grants — Vorbereitung auf Supabase-Schema-Default-Change
--
-- Hintergrund: Supabase ändert ab dem 30. Mai 2026 (neue Projekte) bzw.
-- 30. Oktober 2026 (neue Tabellen in bestehenden Projekten) das Default-
-- Verhalten: Tabellen im `public`-Schema werden nicht mehr automatisch
-- über die Data API (PostgREST / GraphQL / supabase-js) exposed. Ohne
-- expliziten GRANT bleiben sie für die Rollen `anon`/`authenticated`
-- unsichtbar.
--
-- Unsere Crew-Lese-Pfade (Cookie-basierter Client) laufen als Rolle
-- `authenticated`. Schreib-Pfade laufen als `service_role` (bypasst
-- Permissions) und sind nicht betroffen.
--
-- Diese Migration:
--   1. setzt explizite GRANTs auf alle bestehenden Tabellen/Views/
--      Functions (heute redundant zu Auto-Grants, aber ab 30.10.2026
--      die Absicherung)
--   2. setzt `ALTER DEFAULT PRIVILEGES`, damit alle künftig angelegten
--      Tabellen automatisch die richtigen GRANTs bekommen
--
-- Sicherheit: GRANT erlaubt nur den Zugriff auf die Tabelle als solche.
-- Die Row-Level-Security-Policies aus 0004_rls.sql filtern weiterhin,
-- welche Rows ein eingeloggter User tatsächlich zu sehen bekommt.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Bestehende Tabellen ─────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── 2. Bestehende Views ────────────────────────────────────────────────
-- v_balances, v_transaction_shares (aus 0002_views.sql + 0015_per_person_views.sql)
-- werden über ALL TABLES nicht erfasst — Views brauchen separaten GRANT.
DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT table_name
    FROM information_schema.views
    WHERE table_schema = 'public'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_name);
  END LOOP;
END $$;

-- ── 3. Functions, die der Crew-Cookie-Client aufruft ───────────────────
-- simplify_debts() wird in lib/queries/balances.ts via rpc() aufgerufen.
-- Aktuell läuft das nur, weil PostgreSQL `EXECUTE` für `SECURITY DEFINER`-
-- Functions standardmäßig an PUBLIC vergibt — nach dem Supabase-Change
-- ist das nicht mehr selbstverständlich, daher explizit:
GRANT EXECUTE ON FUNCTION simplify_debts(UUID) TO authenticated;

-- ── 4. Default-Privileges für zukünftige Tabellen ──────────────────────
-- Damit künftige Migrationen (CREATE TABLE foo …) nicht jedes Mal
-- explizit GRANT-Statements ergänzen müssen.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

-- Functions sind individuell — bei `SECURITY DEFINER` muss bewusst
-- entschieden werden, wer sie aufrufen darf, daher KEIN globaler Default.
