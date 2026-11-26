-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Regression zu Migration 0066 (Sicherheitsrunde 2026-11, Slice 18)
--
--   1. `anon` hat auf KEINE Tabelle/View/Sequenz in public irgendein Recht
--      und auf keine eigene Funktion EXECUTE (Extension-Funktionen wie
--      citext/pgtap ausgenommen — deren Objekte gehören der Extension bzw.
--      supabase_admin; pgtap gibt es nur in der Testumgebung).
--   2. `authenticated`/`service_role` sind unverändert: Lesepfad,
--      Policy-Helfer, simplify_debts; gesperrte Funktionen bleiben gesperrt.
--   3. Vorgaben: eine NEU angelegte Tabelle/Funktion/Sequenz ist für anon
--      bzw. PUBLIC nicht freigegeben (funktional geprüft — Objekte im Test
--      anlegen); ein expliziter GRANT an authenticated genügt.
--   4. JEDE eigene View in public trägt security_invoker=on (generisch, damit ein
--      späteres `CREATE OR REPLACE VIEW` ohne WITH-Klausel auffällt — es
--      setzt reloptions zurück).
--   5. Keine Funktion/View/Policy liest `app.settings.*` (Voraussetzung,
--      um die JWT-Secret-Einstellung zurückzusetzen).
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(26);

-- ── 1. anon: keine Rechte ─────────────────────────────────────────────
SELECT is(
  (SELECT count(*)::int FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass
                         AND d.objid = c.oid AND d.deptype = 'e')
      AND has_table_privilege('anon', c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  0, 'anon: kein Recht auf irgendeine Tabelle/View in public');

SELECT is(
  (SELECT count(*)::int FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND CASE WHEN c.relkind = 'S'   -- CASE erzwingt die Reihenfolge
               THEN has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
               ELSE FALSE END),
  0, 'anon: kein Recht auf irgendeine Sequenz in public');

SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_proc'::regclass
                         AND d.objid = p.oid AND d.deptype = 'e')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  0, 'anon: EXECUTE auf keiner eigenen Funktion in public');

-- Stichprobe, damit die Zählungen nicht leer laufen
SELECT ok(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public') > 20,
  'Gegenprobe: public enthält eigene Funktionen');

-- Funktional: anonymer Lesezugriff scheitert am GRANT, nicht erst an RLS
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT 1 FROM persons LIMIT 1', '42501', NULL,
  'anon: SELECT auf persons → permission denied');
SELECT throws_ok('SELECT 1 FROM v_balances LIMIT 1', '42501', NULL,
  'anon: SELECT auf v_balances → permission denied');
SELECT throws_ok($$SELECT is_trip_member('aaaaaaaa-0000-4000-8000-000000000001')$$,
  '42501', NULL, 'anon: Policy-Helfer is_trip_member → permission denied');
RESET ROLE;

-- ── 2. authenticated / service_role unverändert ──────────────────────
SELECT ok(has_table_privilege('authenticated', 'persons', 'SELECT'),
  'authenticated: SELECT auf persons');
SELECT ok(has_table_privilege('authenticated', 'v_balances', 'SELECT'),
  'authenticated: SELECT auf v_balances');
SELECT ok(NOT has_table_privilege('authenticated', 'persons', 'INSERT'),
  'authenticated: weiterhin kein INSERT (0050)');
SELECT ok(has_function_privilege('authenticated', 'is_trip_member(uuid)', 'EXECUTE'),
  'authenticated: is_trip_member (Policy-Helfer)');
SELECT ok(has_function_privilege('authenticated', 'is_trip_skipper(uuid)', 'EXECUTE'),
  'authenticated: is_trip_skipper (Policy-Helfer)');
SELECT ok(has_function_privilege('authenticated', 'current_person_id()', 'EXECUTE'),
  'authenticated: current_person_id (Policy-Helfer)');
SELECT ok(has_function_privilege('authenticated', 'simplify_debts(uuid)', 'EXECUTE'),
  'authenticated: simplify_debts (Schulden-Seite)');
SELECT ok(NOT has_function_privilege('authenticated', 'purge_trip_data(uuid, boolean)', 'EXECUTE'),
  'authenticated: purge_trip_data bleibt gesperrt (0049)');
SELECT ok(has_function_privilege('service_role', 'purge_trip_data(uuid, boolean)', 'EXECUTE'),
  'service_role: purge_trip_data weiterhin ausführbar');
SELECT ok(has_function_privilege('service_role', 'is_trip_member(uuid)', 'EXECUTE'),
  'service_role: is_trip_member weiterhin ausführbar');
SELECT ok(NOT has_function_privilege('authenticated', 'cleanup_login_rate_limit()', 'EXECUTE'),
  'authenticated: cleanup_login_rate_limit gesperrt (war über die Schema-Vorgabe offen)');
SELECT ok(has_function_privilege('service_role', 'cleanup_login_rate_limit()', 'EXECUTE'),
  'service_role: cleanup_login_rate_limit weiterhin ausführbar (Purge-Cron)');

-- ── 3. Vorgaben für neue Objekte (funktional, Rollback am Ende) ──────
CREATE TABLE public.zz_slice18_probe (id BIGSERIAL PRIMARY KEY);
CREATE FUNCTION public.zz_slice18_probe_fn() RETURNS INT LANGUAGE sql AS 'SELECT 1';

SELECT ok(NOT has_table_privilege('anon', 'public.zz_slice18_probe', 'SELECT'),
  'neue Tabelle: kein SELECT für anon');
SELECT ok(NOT has_sequence_privilege('anon', 'public.zz_slice18_probe_id_seq', 'USAGE'),
  'neue Sequenz: kein USAGE für anon');
SELECT ok(NOT has_function_privilege('anon', 'public.zz_slice18_probe_fn()', 'EXECUTE'),
  'neue Funktion: kein EXECUTE für anon (auch nicht über PUBLIC)');
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = 'public.zz_slice18_probe_fn()'::regprocedure
                 AND a.grantee = 0),
  'neue Funktion: keine PUBLIC-Freigabe in der ACL');
-- Ob authenticated/service_role eine NEUE Funktion schon per Vorgabe
-- ausführen dürfen, hängt von der Umgebung ab (pg_default_acl der Rolle
-- postgres: lokal mit, in CI nach frischem `supabase start` ohne
-- authenticated). Garantiert ist nur: anon/PUBLIC nicht (oben) — und dass
-- der explizite GRANT laut Konvention genügt. Die Vorgaben werden zur
-- Diagnose ausgegeben.
SELECT diag('pg_default_acl postgres: ' || COALESCE((
  SELECT string_agg(COALESCE(d.defaclnamespace::regnamespace::text, '(global)')
                    || '/' || d.defaclobjtype::text || '=' || d.defaclacl::text, '; ')
    FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole), '(keine)'));
GRANT EXECUTE ON FUNCTION public.zz_slice18_probe_fn() TO authenticated, service_role;
SELECT ok(has_function_privilege('authenticated', 'public.zz_slice18_probe_fn()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.zz_slice18_probe_fn()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.zz_slice18_probe_fn()', 'EXECUTE'),
  'neue Funktion: expliziter GRANT (Konvention) reicht für authenticated/service_role, anon bleibt draußen');

-- ── 4. Alle Views security_invoker=on ────────────────────────────────
SELECT is(
  (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass
                         AND d.objid = c.oid AND d.deptype = 'e')
      -- Wert normalisiert lesen: `= true` steht als 'security_invoker=true'
      -- in reloptions, wäre per Array-Vergleich ein Fehlalarm.
      AND NOT COALESCE((SELECT o.option_value::boolean
                          FROM pg_options_to_table(c.reloptions) o
                         WHERE o.option_name = 'security_invoker'), FALSE)),
  NULL, 'jede View in public hat security_invoker=on');

-- ── 5. Niemand liest app.settings.* ──────────────────────────────────
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE prosrc ILIKE '%app.settings%')
  + (SELECT count(*)::int FROM pg_views WHERE definition ILIKE '%app.settings%')
  + (SELECT count(*)::int FROM pg_policies
      WHERE COALESCE(qual, '') ILIKE '%app.settings%'
         OR COALESCE(with_check, '') ILIKE '%app.settings%'),
  0, 'keine Funktion/View/Policy liest app.settings.* (JWT-Secret-Einstellung entbehrlich)');

SELECT * FROM finish();
ROLLBACK;
