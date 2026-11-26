-- ═══════════════════════════════════════════════════════════════════════
-- Lagebild Produktion 2026-11 (Slice 0 der Sicherheitsrunde)
--
-- REIN LESEND: nur SELECT, Ausgabe nur Zahlen bzw. Ja/Nein — keine Adressen,
-- keine Namen, keine IDs. Jede Abfrage steht für sich; ein Fehler (z. B. eine
-- fehlende Spalte) bricht die übrigen NICHT ab (kein ON_ERROR_STOP).
--
-- DB-Nutzer: `supabase_admin` (Superuser dieses Images; die auth-Tabellen
-- gehören `supabase_auth_admin`, `postgres` sieht sie ggf. nicht oder nur
-- teilweise — gleiche Begründung wie in self-host/backup.sh). Das Skript
-- erzwingt zusätzlich eine read-only-Transaktion über PGOPTIONS.
--
-- Aufruf als temporärer Coolify Scheduled Task (Supabase-Ressource, Container
-- `db`; hinterher Task löschen). admins = die Werte aus ADMIN_EMAILS,
-- kommagetrennt (nur im Task-Befehl, nirgends committen):
--
--   wget -qO- https://raw.githubusercontent.com/Jannik96D/bordkasse-public/<branch>/webapp/supabase/ops/lagebild-2026-11.sql | PGOPTIONS='-c default_transaction_read_only=on' psql -U supabase_admin -d postgres -v admins="a@example.org,b@example.org" -f -
--
-- (psql-Variablen funktionieren mit `-f -`; die \echo-Überschriften erscheinen
-- im Task-Log. Ohne -v admins läuft Abschnitt G mit leerer Liste.)
--
-- Ergebnisse in docs/security-audit-2026-11-PROGRESS.md eintragen.
-- ═══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off
\pset pager off
\if :{?admins}
\else
  \set admins ''
\endif

\echo
\echo '== A: Signups (auth.audit_log_entries, Aktion user_signedup) nach Provider =='
\echo '   (leere Historie ist kein Entlastungsbeweis)'
SELECT COALESCE(payload->'traits'->>'provider', '(kein Provider)') AS provider,
       count(*) AS anzahl
FROM   auth.audit_log_entries
WHERE  payload->>'action' = 'user_signedup'
GROUP  BY 1
ORDER  BY anzahl DESC;

\echo
\echo '== A2: Audit-Historie gesamt (Einträge, ältester/jüngster Tag) =='
SELECT count(*) AS eintraege, min(created_at)::date AS aeltester, max(created_at)::date AS juengster
FROM   auth.audit_log_entries;

\echo
\echo '== B: Audit-Aktionen (auth.audit_log_entries), Top 15 =='
SELECT payload->>'action' AS aktion, count(*) AS anzahl
FROM   auth.audit_log_entries
GROUP  BY 1
ORDER  BY anzahl DESC
LIMIT  15;

\echo
\echo '== C: Konten / Sessions mit Passwort-Login (auth.mfa_amr_claims, authentication_method=password) =='
SELECT count(DISTINCT s.user_id) AS konten,
       count(DISTINCT s.id)      AS sessions
FROM   auth.mfa_amr_claims c
JOIN   auth.sessions s ON s.id = c.session_id
WHERE  c.authentication_method = 'password';

\echo
\echo '== D: auth.users gesamt / unbestätigt (email_confirmed_at IS NULL) =='
SELECT count(*)                                              AS gesamt,
       count(*) FILTER (WHERE email_confirmed_at IS NULL)    AS unbestaetigt
FROM   auth.users;

\echo
\echo '== E: persons mit auth_user_id ohne trip_members-Zeile und ohne trips.skipper_id =='
SELECT count(*) AS fremdkonten_ohne_toern
FROM   persons p
WHERE  p.auth_user_id IS NOT NULL
  AND  NOT EXISTS (SELECT 1 FROM trip_members m WHERE m.person_id = p.id)
  AND  NOT EXISTS (SELECT 1 FROM trips t WHERE t.skipper_id = p.id);

\echo
\echo '== F: auth.users ohne verknüpfte persons UND ohne persons_private-Eintrag (lower(email)) =='
SELECT count(*) AS auth_konten_ohne_person
FROM   auth.users u
WHERE  NOT EXISTS (SELECT 1 FROM persons p WHERE p.auth_user_id = u.id)
  AND  NOT EXISTS (SELECT 1 FROM persons_private pp WHERE lower(pp.email::text) = lower(u.email));

\echo
\echo '== G: je ADMIN_EMAILS-Adresse (nur Index): Konto, Passwort-Session, persons_private =='
WITH a AS (
  SELECT ord::int AS idx, lower(btrim(addr)) AS addr
  FROM   unnest(string_to_array(:'admins', ',')) WITH ORDINALITY AS t(addr, ord)
  WHERE  btrim(addr) <> ''
)
SELECT a.idx AS admin_index,
       EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = a.addr) AS konto_vorhanden,
       EXISTS (SELECT 1 FROM auth.users u
               JOIN auth.sessions s ON s.user_id = u.id
               JOIN auth.mfa_amr_claims c ON c.session_id = s.id
               WHERE lower(u.email) = a.addr
                 AND c.authentication_method = 'password') AS passwort_session_vorhanden,
       EXISTS (SELECT 1 FROM persons_private pp WHERE lower(pp.email::text) = a.addr) AS in_persons_private
FROM   a
ORDER  BY a.idx;

\echo
\echo '== Ende Lagebild =='
