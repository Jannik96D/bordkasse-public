-- =============================================================================
-- Sicherheitsrunde 2026-11, Slice 1 — einmaliger Backfill des Konto-Ankers
-- =============================================================================
--
-- KEINE Migration. Wird vom Nutzer EINMAL manuell auf Prod ausgeführt.
--
-- ⚠️ REIHENFOLGE:
--   1. Slice 0 (Lagebild) ist gelaufen und hat KEINEN Hinweis auf Missbrauch
--      gezeigt (Signups am App-Login vorbei, Passwort-Logins, Fremdkonten).
--   2. Slice 1 ist gemergt und deployt.
--   3. Lauf 1 (ohne Variable) liest nur und gibt Zahlen aus. A3 muss 0 sein —
--      und zwar schon VOR dem Deploy von Slice 1 geprüft (siehe unten).
--   4. Lauf 2 mit `-v expect=<Zahl "zu_ankern" aus Lauf 1>` schreibt — aber
--      nur, wenn die Kandidatenzahl unverändert ist; sonst bricht er ohne
--      Änderung ab (seit Lauf 1 neu entstandene Konten würden sonst
--      ungeprüft mitgeankert).
--   5. Erst danach Slice 2 (DISABLE_SIGNUP=true, Kong-Allowlist).
--
-- AUFRUF (Muster aus CLAUDE.md, temporärer Coolify Scheduled Task auf der
-- Supabase-Ressource, Container `db`; als `supabase_admin`, weil `auth.users`
-- `supabase_auth_admin` gehört):
--
--   Lauf 1 (nur lesen):
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -f <datei>
--   Lauf 2 (schreiben), erst nach Sichtprüfung von Lauf 1:
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -v expect=<N> --single-transaction -f <datei>
--
-- (Die Datei liegt im öffentlichen Repo; im db-Container per
--  `wget -qO /tmp/backfill.sql <raw-URL>` holen, dann `-f /tmp/backfill.sql`.)
--
-- Die Ausgabe enthält NUR Zahlen, keine Adressen.
--
-- WAS ES TUT: setzt `raw_app_meta_data.bordkasse_email` (den Anker, den
-- `getCurrentPerson`/`ensureAuthUser` auswerten) und bestätigt unbestätigte
-- Konten (`email_confirmed_at`) — ausschließlich für Konten, die bereits mit
-- einer Person verknüpft sind (`persons.auth_user_id`) UND deren
-- Konto-Adresse der Adresse dieser Person in `persons_private` entspricht.
-- Konten mit Anker, gelöschte (`deleted_at`) und anonyme Konten bleiben
-- unberührt; idempotent.
--
-- BEWUSST NICHT geankert:
--   * Unverknüpfte Konten (auch wenn ihre Adresse einer Ghost-Person gehört):
--     sie sind nicht von einem am App-Login vorbei per Signup angelegten
--     Konto zu unterscheiden. Die App löscht sie beim nächsten Login bzw. der
--     nächsten Einladung und legt sie geankert neu an (ensureAuthUser).
--   * Verknüpfte Konten mit ABWEICHENDER oder FEHLENDER Personen-Adresse (A3):
--     - abweichend: die App ändert Konto-Adressen nie, das Konto hat seine
--       Adresse per `PUT /auth/v1/user` geändert. ensureAuthUser setzt es auf
--       die Personen-Adresse zurück, sobald seine besetzte Adresse angefragt
--       wird (Missbrauch? ansehen).
--     - fehlend (`persons_private` ohne Zeile, z. B. alter Admin mit damals
--       gescheitertem Insert): ensureAuthUser kennt die rechtmäßige Adresse
--       nicht und bricht für die Konto-Adresse fail-closed ab
--       (`linked_without_address`) — dieser Nutzer bekommt keinen neuen
--       Login-Link, bis die Zeile von Hand nachgetragen ist.
--     A3 deshalb VOR dem Deploy von Slice 1 lesend gegen Prod laufen lassen
--     (nur diese Abfrage, Erwartung 0) und Treffer vorher klären.
--
-- WARUM ÜBERHAUPT (Slice 1 funktioniert auch ohne): verknüpfte Konten finden
-- ihre Person über `auth_user_id` ohne Anker. Der Anker unterscheidet aber in
-- ensureAuthUser „gehört mir" von „besetzt", und der Backfill bestätigt
-- unbestätigte Altkonten, bevor Slice 2 den Signup schließt.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TEIL A — nur lesen
-- ---------------------------------------------------------------------------
\echo 'A1: Konten gesamt / mit Anker / unbestätigt'
SELECT count(*)                                                                         AS konten,
       count(*) FILTER (WHERE coalesce(u.raw_app_meta_data ? 'bordkasse_email', false)) AS mit_anker,
       count(*) FILTER (WHERE u.email_confirmed_at IS NULL)                              AS unbestaetigt
FROM auth.users u;

\echo 'A2: zu ankern (verknüpft, Adresse passt, noch ohne Anker)'
SELECT count(*) AS zu_ankern
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT coalesce(u.raw_app_meta_data ? 'bordkasse_email', false)
  AND u.deleted_at IS NULL
  AND NOT coalesce(u.is_anonymous, false)
  AND EXISTS (
    SELECT 1 FROM public.persons p
    JOIN public.persons_private pp ON pp.person_id = p.id
    WHERE p.auth_user_id = u.id AND lower(pp.email::text) = lower(u.email)
  );

\echo 'A3: AUFFÄLLIG — verknüpfte Konten mit abweichender oder fehlender Personen-Adresse (Erwartung 0)'
SELECT count(*) AS adresse_abweichend
FROM auth.users u
JOIN public.persons p ON p.auth_user_id = u.id
LEFT JOIN public.persons_private pp ON pp.person_id = p.id
WHERE pp.email IS NULL OR lower(pp.email::text) <> lower(coalesce(u.email, ''));

\echo 'A4: unverknüpfte Konten ohne Anker (werden nicht geankert, die App legt sie bei Bedarf neu an)'
SELECT count(*) AS unverknuepft_ohne_anker
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.persons p WHERE p.auth_user_id = u.id)
  AND NOT coalesce(u.raw_app_meta_data ? 'bordkasse_email', false)
  AND u.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- TEIL B — schreiben, nur mit `-v expect=<N>` und nur bei unveränderter Zahl
-- ---------------------------------------------------------------------------
\if :{?expect}
SELECT (count(*) = :'expect'::int) AS zahl_passt
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT coalesce(u.raw_app_meta_data ? 'bordkasse_email', false)
  AND u.deleted_at IS NULL
  AND NOT coalesce(u.is_anonymous, false)
  AND EXISTS (
    SELECT 1 FROM public.persons p
    JOIN public.persons_private pp ON pp.person_id = p.id
    WHERE p.auth_user_id = u.id AND lower(pp.email::text) = lower(u.email)
  ) \gset
\if :zahl_passt
\echo 'B: Anker setzen + unbestätigte Kandidaten bestätigen'
WITH geaendert AS (
  UPDATE auth.users u
  SET raw_app_meta_data  = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('bordkasse_email', lower(u.email)),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      updated_at         = now()
  WHERE u.email IS NOT NULL
    AND NOT coalesce(u.raw_app_meta_data ? 'bordkasse_email', false)
    AND u.deleted_at IS NULL
    AND NOT coalesce(u.is_anonymous, false)
    AND EXISTS (
      SELECT 1 FROM public.persons p
      JOIN public.persons_private pp ON pp.person_id = p.id
      WHERE p.auth_user_id = u.id AND lower(pp.email::text) = lower(u.email)
    )
  RETURNING u.id
)
SELECT count(*) AS geankert FROM geaendert;

\echo 'Kontrolle: Konten mit Anker danach'
SELECT count(*) FILTER (WHERE coalesce(raw_app_meta_data ? 'bordkasse_email', false)) AS mit_anker
FROM auth.users;
\else
\echo 'ABBRUCH: Kandidatenzahl weicht von expect ab — nichts geschrieben. Lauf 1 wiederholen.'
\endif
\else
\echo 'TEIL B übersprungen (nur gelesen). Zum Schreiben erneut mit -v expect=<zu_ankern aus A2> ausführen.'
\endif
