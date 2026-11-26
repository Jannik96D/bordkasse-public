# Sicherheitsrunde 2026-11 — Stand (Progress)

Zustandsdokument der Runde. Plan: `docs/security-audit-2026-11-PLAN.md`, Startprompt:
`docs/security-audit-2026-11-KICKOFF.md`. Wird in **jedem** Slice-PR fortgeschrieben (Status,
PR-Link, Migration, Eingriff).

Legende Status: `offen` · `in Arbeit` · `PR offen` · `gemergt` · `wartet auf 🖐`.

## Slices

| # | Slice | Status | PR | Migration | 🖐-Eingriff |
| --- | --- | --- | --- | --- | --- |
| 0 | Lagebild Produktion, Plan ins Repo | PR offen | – | – | ja: `DISABLE_SIGNUP` ablesen, Lagebild-Skript als Task laufen lassen |
| 1 | Konten serverseitig, Anker, Schritt 3 | offen | – | – | Backfill |
| 2 | Kong-Allowlist, Signup aus, Sitzungsdauer | offen | – | – | ja: Coolify-Variablen, Neustart Supabase-Stack |
| 3 | Geteilte Personen: Name/E-Mail nur mit Zuständigkeit | offen | – | – | – |
| 4 | Login-CSRF in `/auth/verify` | offen | – | – | – |
| 5 | Kontolöschung ohne Verschiebung | PR offen | [#302](https://github.com/Jannik96D/bordkasse-public/pull/302) | 0063 | Migration vor Merge einspielen |
| 6 | Erzwungene Löschung nur Eigentümer | offen | – | – | – |
| 7 | Anzahlungs-Rechte | offen | – | – | – |
| 8 | Kategorie an Törn binden | offen | – | 0064 | Migration vor Merge einspielen |
| 9 | Nachträgliche Saldo-Änderungen | offen | – | – | – |
| 10 | Mail drosseln, Auth-Konten aufräumen | offen | – | – | – |
| 11 | Rohe Fehlertexte | offen | – | – | – |
| 12 | Geteilte Geräte | offen | – | – | – |
| 13 | Secure-Cookies | offen | – | – | – |
| 14 | Realtime-Publikation | offen | – | 0065 | Migration vor Merge einspielen |
| 15 | Backups mit Rechten und Verschlüsselung | offen | – | – | ja: Server-Betreiber, Schlüssel |
| 16 | CI mit minimalen Rechten | offen | – | – | – |
| 17 | Abhängigkeiten | offen | – | – | – |
| 18 | DB-Härtung (Sammelslice) | offen | – | 0066 | ja |

## Entscheidungen

- **Slice 3 (Zuständigkeit bei geteilten Personen):** Name/E-Mail einer Person darf ändern, wer
  **Skipper ALLER Törns der Person** ist, **ODER globaler Admin**, **ODER die Person selbst**.
- **Slice 2 (Sitzungsdauer):** Session-Inaktivitäts-Timeout **90 Tage**.
- **Slice 15 (Backup-Verschlüsselung):** `openssl` hybrid; der **private Schlüssel liegt offline
  beim Nutzer**, nie auf dem Server.
- **Merge:** unverändert — **jeder PR braucht ein frisches Ja des Nutzers** (`gh pr merge` nie
  ohne).
- Geteilte Personen sind gewollt (Crew mehrerer Törns/Skipper); der Fix sperrt nur das Ändern.
- Autoconfirm bleibt `true`; `PUT /auth/v1/user` wird in Kong gesperrt (Slice 2).

## Lagebild Produktion

Skript: `webapp/supabase/ops/lagebild-2026-11.sql` (nur `SELECT`, nur Zahlen/Ja-Nein).
Ausführung durch den Nutzer (Aufruf im Skript-Kopf). Ergebnisse hier eintragen, **ohne**
Adressen oder Namen.

| Punkt | Wert |
| --- | --- |
| `DISABLE_SIGNUP` der Supabase-Ressource | unbekannt (🖐 in Coolify ablesen) |
| A Signups nach Provider (`user_signedup`) | ausstehend |
| A2 Alter der Audit-Historie | ausstehend |
| B Audit-Aktionen Top 15 | ausstehend |
| C Konten/Sessions mit Passwort-Login | ausstehend |
| D `auth.users` gesamt / unbestätigt | ausstehend |
| E Personen mit Konto, aber ohne Törn | ausstehend |
| F Auth-Konten ohne Person/`persons_private` | ausstehend |
| G je Admin-Adresse (Index): Konto / Passwort-Session / `persons_private` | ausstehend |

Deutet etwas auf Missbrauch, entscheidet der Nutzer über das Sperren betroffener Konten
(`auth.admin.updateUserById(…, { ban_duration })`); Slice 1/2 werden dann sofort gezogen.

## Bootstrap für Folgesessions

1. `CLAUDE.md` (Repo-Root) und `docs/security-audit-2026-11-PLAN.md` lesen („Arbeitsweise",
   der jeweilige Slice, „Reihenfolge und Modellstufen"); dieses Dokument für den Stand.
2. Nächsten `offen`-Slice laut Reihenfolge wählen (0 → 1 → 3/4 → 2 → 5 → 9 → 6 → 7 → 8 → 10 →
   11 → 12 → 13 → 14 → 15 → 16 → 17 → 18; gleiche Datei = nacheinander).
3. Branch frisch von `origin/main` (`security/slice-<n>-<kurzname>`), implementieren, `cd webapp
   && pnpm typecheck && pnpm lint && pnpm test` (bei Migration `pnpm test:db`).
4. Grill durch unabhängigen Subagenten ohne Kontext, neue Tests mutieren (Rücksetzen per
   Datei-Backup, nie `git checkout -- .`).
5. PR gegen `main`, Doku (`CLAUDE.md`, betroffene Spec, dieses Dokument) im selben PR; CI
   abwarten; **nicht mergen** ohne frisches Ja des Nutzers.
6. Migrationen laufen vor dem App-Deploy auf Prod (Nutzer); nichts gegen Produktion ausprobieren;
   keine Personendaten in Doku, Commits oder PRs.
