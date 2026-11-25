# Kick-off: Sicherheitsrunde 2026-11 umsetzen

> Diesen Text als erste Nachricht in eine **neue** Claude-Code-Session im Repo
> `bordkasse-public` kopieren.

---

Du bist Orchestrator für die Sicherheitsrunde 2026-11 der Bordkasse. Du setzt den Plan
`docs/security-audit-2026-11-PLAN.md` Slice für Slice um und lässt die eigentliche Arbeit von
Subagenten machen. Du selbst implementierst nicht, du steuerst, prüfst und berichtest.

## 1. Einlesen (bevor irgendetwas passiert)

1. `git fetch origin` und prüfen, wo der Plan liegt: auf `main` oder auf dem Branch
   `claude/security-test-application-7cccae` (dort entstanden; dann mit
   `git show origin/claude/security-test-application-7cccae:docs/security-audit-2026-11-PLAN.md`
   lesen). Slice 0 bringt ihn nach `main`.
2. Vollständig lesen: `CLAUDE.md`, den Plan (vor allem „Arbeitsweise", „Grill-Runde 1",
   „Reihenfolge"), und `docs/security-audit-2026-11-PROGRESS.md`, falls es schon existiert. Das
   Progress-Dokument ist die Wahrheit über den Stand, nicht deine Erinnerung.
3. Bodenwahrheit prüfen: `gh pr list --state all --search "Sicherheitsrunde"`, `git log --oneline
   origin/main -20`. Ein Slice gilt nur als erledigt, wenn sein PR gemergt ist **und** das
   Progress-Dokument das sagt.

## 2. Vor dem ersten Code-Slice den Nutzer fragen

Mit einer einzigen Frage-Runde (AskUserQuestion), nicht verteilt:
- **Slice 0:** Wert von `DISABLE_SIGNUP` in Coolify (Supabase-Ressource) und die Ergebnisse der
  Lagebild-Abfragen. Bereite die SQL-Abfragen als fertigen, rein lesenden Task-Befehl vor; der
  Nutzer führt ihn als temporären Scheduled Task aus (Coolify-Tasks lassen sich nicht per API
  auslösen). Ausgaben nur als Zahlen, keine Adressen.
- **Slice 3:** Wer darf Name/E-Mail einer geteilten Person ändern — „Skipper aller ihrer Törns
  oder Admin" (Vorschlag) oder „nur Admin"?
- **Slice 2:** Länge des Session-Inaktivitäts-Timeouts (Vorschlag 90 Tage).
- **Slice 15:** Backup-Verschlüsselung mit `openssl` (hybrid) oder anderes Werkzeug; wer hält
  den privaten Schlüssel?

Deutet Slice 0 auf Missbrauch hin, stopp: Befund melden, der Nutzer entscheidet über das Sperren
von Konten, dann Slice 1 und 2 vor allem anderen.

## 3. Ablauf pro Slice

Reihenfolge laut Tabelle „Reihenfolge und Modellstufen". Parallel nur Slices, die laut Plan
andere Dateien berühren, höchstens zwei gleichzeitig.

**a) Umsetzungs-Subagent starten** (Agent-Tool, `isolation: "worktree"`, Modell laut Tabelle).
Der Prompt enthält:
- den vollständigen Text des Slice aus dem Plan (kopiert, nicht nur die Nummer) plus die
  Abschnitte „Arbeitsweise" und „Verifikation";
- Branch `security/slice-<nr>-<kurzname>` frisch von `origin/main`;
- Pflichten: `pnpm typecheck && pnpm lint && pnpm test` (bei Migrationen zusätzlich
  `pnpm test:db`) grün; jeden neuen Test mutieren (muss ohne den Fix rot werden; vor der Mutation
  die Datei per `cp` sichern und per `cp` zurückspielen, **niemals** `git checkout -- .`);
  `CLAUDE.md`, betroffene `docs/`-Spec und `docs/security-audit-2026-11-PROGRESS.md` im selben
  Commit fortschreiben; Commit-Nachricht und PR auf Deutsch wie die bisherigen PRs, mit den
  Attributionszeilen aus der Session;
- PR öffnen, **nicht mergen**;
- verboten: Bash-`sleep`, Background-Polling über Turns, Angriffe gegen Produktion, Änderungen an
  Coolify/Traefik, Personendaten (Namen, Adressen) in Logs, Tests oder Ausgaben;
- lokale Container (colima, `supabase start`, Self-Host-Stack per `docker compose`) jeweils als
  eigenes, abgeschlossenes Kommando starten (Mac-Last);
- der Subagent darf seinen Turn **nicht** mit einem Warte-Satz beenden, sondern liefert am Ende:
  Branch, Commit-SHA, PR-Link, Testergebnis, Mutationsergebnis, offene Fragen.

**b) Grill-Subagent starten** (neuer Agent ohne Kontext, Opus bei Auth/Migration/Geldlogik,
sonst Sonnet). Er bekommt nur: PR-Nummer/Branch, den Slice-Text, den Hinweis auf `CLAUDE.md`,
und den Auftrag, den Diff selbst per `git diff origin/main...<branch>` zu holen und aktiv nach
Bugs, Sicherheitslücken, Edge Cases und blinden Tests zu suchen. Nicht deine Einschätzung
mitgeben.

**c) Funde beheben** über `SendMessage` an den Umsetzungs-Subagenten (er hat den Kontext). Nach
größeren Korrekturen erneut grillen.

**d) Selbst prüfen**, bevor du dem Nutzer etwas meldest: `git log --oneline -3 origin/<branch>`,
`gh pr diff <nr> --name-only` (keine unerwarteten Dateien), `gh pr checks <nr>`. Ein
„completed"-Status eines Subagenten ist kein Fertigsignal — lies seinen Bericht.

**e) Merge:** Nie selbst entscheiden. Dem Nutzer pro PR melden: was geändert wurde, was der Grill
fand, Testergebnis, CI-Status. Dann fragen. Erst nach einem ausdrücklichen Ja für **diesen** PR
`gh pr merge`.
- **Slices mit Migration:** vor der Merge-Frage den fertigen Task-Befehl zum Einspielen auf Prod
  geben (Muster aus `CLAUDE.md`: `wget … | psql … --single-transaction`, danach Eintrag in
  `supabase_migrations.schema_migrations`, danach `NOTIFY pgrst, 'reload schema'`). Gemergt wird
  erst, wenn der Nutzer bestätigt, dass die Migration live ist.
- **🖐-Slices:** PR vorbereiten, dann dem Nutzer die genauen Schritte (Coolify-Variable,
  Neustart, Absprache) als nummerierte Liste geben und auf seine Bestätigung warten.

**f) Nach dem Merge:** Progress-Dokument auf `main` prüfen, nächsten Slice beginnen (Branch frisch
von `origin/main`).

## 4. Harte Grenzen

- Kein Merge ohne frisches Ja pro PR.
- Keine Änderung an der Produktion durch dich oder einen Subagenten (Coolify, Server, Prod-DB);
  du lieferst nur fertige Befehle, der Nutzer führt sie aus.
- Keine Angriffe gegen `bordkasse.dieter.ms` oder `sb.bordkasse.dieter.ms`, auch keine
  „harmlosen" Proben. Nachstellen nur lokal.
- Slice 2 erst, wenn Slice 1 gemergt, deployt und der Anker-Backfill gelaufen ist (sonst sind
  alle Erst-Einladungen kaputt).
- Keine Personendaten in Chat, PRs, Commits oder Logs.

## 5. Berichten

Nach jedem Slice zwei bis vier Sätze an den Nutzer: was jetzt sicher ist, was offen ist, was du
von ihm brauchst. Am Ende der Runde eine Übersicht aller Slices mit PR-Links und den Punkten aus
„Offene Punkte" des Plans, die weiter offen sind.
