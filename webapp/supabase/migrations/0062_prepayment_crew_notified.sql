-- ═══════════════════════════════════════════════════════════════════════
-- 0062 — Benachrichtigungen für Anzahlungsplan und Reise-Posten (PR6)
--
-- Drei rein additive, nullable Zeitstempel-Spalten:
--
--   1. prepayment_plan.crew_notified_at
--      „Die Crew wurde über den fertigen Anzahlungsplan informiert." Wird
--      GENAU EINMAL gesetzt — beim ersten erfolgreichen saveTranches (Wizard
--      Schritt 2). Die App beansprucht den Versand atomar:
--        UPDATE prepayment_plan SET crew_notified_at = now()
--         WHERE trip_id = $1 AND crew_notified_at IS NULL RETURNING trip_id
--      Nur der Request, der die Zeile wirklich trifft, verschickt die Mail
--      „Anzahlungsplan angelegt" — ein Doppelklick, ein Netzwerk-Retry oder
--      jedes spätere Speichern im Wizard verschickt NICHTS mehr. Bewusst
--      claim-first (und nicht „erst Mail, dann Flag" wie beim Reminder-Log):
--      ein doppelter Versand an die ganze Crew wäre schlimmer als ein
--      verpasster, und für Letzteres gibt es den Knopf „Crew informieren".
--      Kein Zurücksetzen: savePrepaymentPlan schreibt den Plan per Upsert auf
--      trip_id, das Flag bleibt dabei erhalten.
--
--   2. prepayment_plan.crew_last_notified_at
--   3. prepayment_items.crew_last_notified_at
--      Zeitpunkt des letzten Versands mit mindestens einer zugestellten Mail
--      (automatisch oder über „Crew informieren"). Nur Anzeige („zuletzt
--      informiert am …") als weicher Spam-Schutz — kein harter Block.
--
-- Bestand: Pläne, die schon Tranchen haben, gelten als „bereits informiert"
-- (Backfill auf now()), sonst bekäme die Crew eines längst laufenden Plans
-- beim nächsten Speichern im Wizard plötzlich eine „Plan angelegt"-Mail.
-- crew_last_notified_at bleibt beim Backfill NULL (unbekannt).
--
-- Keine Personendaten → keine Änderung an purge_trip_data /
-- admin_delete_person_data / delete_my_account nötig (Plan- und
-- Posten-Zeilen werden beim Purge ohnehin komplett gelöscht). Keine neuen
-- Tabellen → keine GRANT/RLS-Änderung; Schreiben bleibt Service-Role-only
-- (0050 hat die Write-Policies entfernt).
--
-- ⚠️ DEPLOY-REIHENFOLGE: diese Migration VOR dem App-Deploy einspielen.
-- Ohne die Spalten bleibt die App lauffähig (fail-soft): die Kernaktionen
-- speichern weiter, die „Plan angelegt"-Mail wird mangels Claim NICHT
-- verschickt (lieber keine als eine bei jedem Speichern), „zuletzt
-- informiert" wird nicht angezeigt. Danach ggf. `NOTIFY pgrst, 'reload
-- schema';`.
--
-- Spec: docs/prepayments.md, Abschnitt „Benachrichtigungen (PR6)"
-- Test: supabase/tests/prepayment_crew_notified_test.sql
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE prepayment_plan
  ADD COLUMN IF NOT EXISTS crew_notified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS crew_last_notified_at TIMESTAMPTZ NULL;

ALTER TABLE prepayment_items
  ADD COLUMN IF NOT EXISTS crew_last_notified_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN prepayment_plan.crew_notified_at IS
  'Einmal-Claim für die Mail „Anzahlungsplan angelegt" (0062). Nie zurücksetzen.';
COMMENT ON COLUMN prepayment_plan.crew_last_notified_at IS
  'Letzter Versand an die Crew mit mind. einer zugestellten Mail (0062).';
COMMENT ON COLUMN prepayment_items.crew_last_notified_at IS
  'Letzter Versand an die Betroffenen des Postens mit mind. einer zugestellten Mail (0062).';

-- Bestand: Pläne mit Tranchen gelten als bereits informiert.
UPDATE prepayment_plan p
   SET crew_notified_at = now()
 WHERE p.crew_notified_at IS NULL
   AND EXISTS (SELECT 1 FROM prepayment_tranches t WHERE t.trip_id = p.trip_id);
