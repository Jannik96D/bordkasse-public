-- ═══════════════════════════════════════════════════════════════════════
-- 0066 — DB-Härtung: `anon` ohne Rechte im Schema public, keine
-- EXECUTE-Vorgabe mehr für PUBLIC (Sicherheitsrunde 2026-11, Slice 18)
--
-- Ausgangslage (lokal gegen das supabase/postgres-Image 17.6 gemessen):
--   - `anon` trägt SELECT/TRUNCATE/REFERENCES/TRIGGER auf jeder Tabelle
--     und View in public (0050 hat nur INSERT/UPDATE/DELETE entzogen) und
--     USAGE/SELECT/UPDATE auf allen Sequenzen. Heute folgenlos, weil alle
--     Policies `TO authenticated` lauten (RLS filtert), aber eine Tabelle
--     ohne RLS wäre ab der ersten Sekunde für jeden mit dem öffentlichen
--     anon-Key lesbar.
--   - Jede neue Funktion bekommt EXECUTE für PUBLIC (eingebaute
--     PostgreSQL-Vorgabe) UND per Schema-Vorgabe der Rolle `postgres`
--     zusätzlich für anon/authenticated/service_role. 0049, 0051, 0058 …
--     mussten das je Funktion von Hand zurücknehmen — wer es vergisst,
--     veröffentlicht eine SECURITY-DEFINER-Funktion über /rest/v1/rpc.
--
-- Die App nutzt `anon` im Schema public an KEINER Stelle (geprüft):
--   - alle Schreib-/RPC-Pfade laufen über den Service-Role-Client,
--   - der Cookie-/Browser-Client liest erst nach dem Login (Rolle
--     `authenticated`, auch die Realtime-Subscription),
--   - `bump_login_rate_limit` ist seit 0043 nur noch service_role.
--
-- Nebenwirkung Realtime (Grill-Fund, dokumentiert): ein anon-Abo OHNE
-- Filter wird von Realtime angenommen; nach 0066 bekommt es bei
-- INSERT/UPDATE auf publizierte Tabellen nur noch {schema, table, type} +
-- „401 Unauthorized“ (Zeitpunkt einer Änderung, keine Daten, keine
-- trip_id). Dafür liefert ein DELETE-Event anon nicht mehr den
-- Primärschlüssel in old_record (Spalten ohne SELECT-Recht werden
-- entfernt) — die in 0065 befürchtete Lücke ist für anon damit zu.
-- NICHT durch `GRANT SELECT (id) … TO anon` „reparieren“, das öffnet sie
-- wieder.
--
-- Was diese Migration tut:
--   0. Bricht ab, wenn ein Nicht-Extension-Objekt in public einer anderen
--      Rolle gehört (sonst bliebe die Härtung still lückenhaft).
--   1. Bestehende Tabellen/Views/Sequenzen: alle Rechte von `anon` weg.
--   2. Bestehende eigene Funktionen (Eigentümer = ausführende Rolle, also
--      `postgres`; KEINE Extension-Funktionen wie citext/pgtap — deren
--      Rechte gehören der Extension, citext-Operatoren braucht jede
--      Abfrage auf persons_private.email): EXECUTE von PUBLIC und anon weg.
--      `authenticated` und `service_role` behalten EXAKT, was sie vorher
--      effektiv hatten — wer es nur über PUBLIC hatte, bekommt es jetzt
--      explizit. Gesperrte Funktionen (0049/0051/0058 …) bleiben gesperrt.
--   2b. `cleanup_login_rate_limit()` (SECURITY DEFINER) auch authenticated
--      entzogen — war laut 0036 „nur service_role“ gemeint.
--   3. Vorgaben für künftige Objekte der Rolle `postgres`:
--      - Schema public: Tabellen/Sequenzen/Funktionen ohne Rechte für anon,
--      - global: Funktionen ohne EXECUTE für PUBLIC.
--      `authenticated`/`service_role` behalten ihre Schema-Vorgaben
--      (u. a. EXECUTE auf neuen Funktionen) — unverändert.
--
-- Bewusst NICHT angefasst:
--   - Vorgaben der Rolle `supabase_admin` (gelten nur für Objekte, die
--     supabase_admin anlegt; volle Rechte inkl. anon). `postgres` ist im
--     Image kein Superuser und darf sie nicht ändern („permission denied
--     to change default privileges“, lokal belegt). Unsere Migrationen
--     laufen als `postgres`, jene Vorgaben greifen für sie also nicht.
--   - Die Datenbankeinstellung `app.settings.jwt_secret`: `postgres` darf
--     sie nicht zurücksetzen (von supabase_admin gesetzt, „permission
--     denied to set parameter“, lokal belegt) → eigenes Ops-Skript
--     `supabase/ops/reset-jwt-setting-2026-11.sql` als supabase_admin,
--     Reihenfolge in docs/self-hosting.md.
--
-- ⚠️ Folge-Konvention für neue Migrationen: eine neue Funktion ist für
-- anon/PUBLIC nicht mehr ausführbar, für authenticated/service_role per
-- Schema-Vorgabe weiterhin schon. Policy-Helfer trotzdem explizit
-- `GRANT EXECUTE … TO authenticated` (macht die Abhängigkeit der RLS
-- sichtbar und übersteht eine spätere Verschärfung der Vorgaben);
-- service-only-Funktionen weiterhin explizit
-- `REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role`.
-- Eine bewusst öffentliche Tabelle/Funktion braucht ab jetzt ein
-- explizites `GRANT … TO anon`.
--
-- Rollback (nicht empfohlen):
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon;
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
--   (Funktions-EXECUTE für PUBLIC je Funktion — bewusst nicht pauschal.)
--
-- Regressionstest: supabase/tests/db_hardening_test.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0. Vorbedingung: alle eigenen Objekte in public gehören uns ─────────
-- REVOKE auf ein fremdes Objekt gibt nur eine WARNING, und die Schleife
-- unten überspringt fremde Funktionen — beides würde die Härtung STILL
-- unvollständig lassen. Deshalb hier laut abbrechen (die Migration läuft
-- per --single-transaction, es ändert sich dann nichts). Extension-Objekte
-- (citext, pgtap) zählen nicht.
DO $$
DECLARE v_fremd TEXT;
BEGIN
  SELECT string_agg(x, ', ') INTO v_fremd FROM (
    SELECT c.oid::regclass::text AS x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass
                         AND d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_proc'::regclass
                         AND d.objid = p.oid AND d.deptype = 'e')
  ) t;
  IF v_fremd IS NOT NULL THEN
    RAISE EXCEPTION '0066: Objekte in public gehören nicht %: % — erst Eigentümer klären (ALTER … OWNER TO %)',
      current_user, v_fremd, current_user;
  END IF;
END $$;

-- ── 1. Bestehende Tabellen, Views, Sequenzen ────────────────────────────
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ── 2. Bestehende eigene Funktionen ─────────────────────────────────────
DO $$
DECLARE
  r        RECORD;
  v_auth   BOOLEAN;
  v_svc    BOOLEAN;
  v_count  INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND NOT EXISTS (                       -- keine Extension-Funktionen
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e')
  LOOP
    -- Effektiven Stand VOR dem Entzug merken (inkl. Vererbung über PUBLIC).
    v_auth := has_function_privilege('authenticated', r.oid, 'EXECUTE');
    v_svc  := has_function_privilege('service_role',  r.oid, 'EXECUTE');

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);

    IF v_auth THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF v_svc THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '0066: % Funktionen in public für PUBLIC/anon gesperrt', v_count;
END $$;

-- ── 2b. cleanup_login_rate_limit nur noch service_role ─────────────────
-- 0036 nahm nur PUBLIC das EXECUTE, die Schema-Vorgabe hatte authenticated
-- aber schon explizit berechtigt — die SECURITY-DEFINER-Funktion war damit
-- für jeden Eingeloggten aufrufbar (Folge gering: löscht nur Zähler älter
-- als einen Tag). Einziger Aufrufer: Purge-Cron über den Service-Role-Client.
REVOKE EXECUTE ON FUNCTION cleanup_login_rate_limit() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION cleanup_login_rate_limit() TO service_role;

-- ── 3. Vorgaben für künftige Objekte der Rolle postgres ─────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon;
-- Die PUBLIC-Vorgabe für Funktionen ist eingebaut und lässt sich NUR global
-- (ohne IN SCHEMA) zurücknehmen — eine Schema-Vorgabe kann Rechte nur
-- hinzufügen. `postgres` legt Funktionen ausschließlich in public an.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
