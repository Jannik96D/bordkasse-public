# Sicherheitsrunde 2026-11 — Stand (Progress)

Zustandsdokument der Runde. Plan: `docs/security-audit-2026-11-PLAN.md`, Startprompt:
`docs/security-audit-2026-11-KICKOFF.md`. Wird in **jedem** Slice-PR fortgeschrieben (Status,
PR-Link, Migration, Eingriff).

Legende Status: `offen` · `in Arbeit` · `PR offen` · `gemergt` · `wartet auf 🖐`.

## Slices

| # | Slice | Status | PR | Migration | 🖐-Eingriff |
| --- | --- | --- | --- | --- | --- |
| 0 | Lagebild Produktion, Plan ins Repo | gemergt | [#298](https://github.com/Jannik96D/bordkasse-public/pull/298) | – | erledigt (Lagebild am 2026-11-26 gelaufen) |
| 1 | Konten serverseitig, Anker, Schritt 3 | gemergt | [#299](https://github.com/Jannik96D/bordkasse-public/pull/299) | – | Backfill optional (A3 = 0 geprüft), vor Slice 2 sinnvoll |
| 2 | Kong-Allowlist, Signup aus, Sitzungsdauer | PR offen | PR_LINK | – | ja: erst App deployen, dann `DISABLE_SIGNUP=true` + Supabase-Ressource neu deployen (Reihenfolge: `docs/self-hosting.md` „Kong-Allowlist“) |
| 3 | Geteilte Personen: Name/E-Mail nur mit Zuständigkeit | gemergt | [#300](https://github.com/Jannik96D/bordkasse-public/pull/300) | – | – |
| 4 | Login-CSRF in `/auth/verify` | gemergt | [#301](https://github.com/Jannik96D/bordkasse-public/pull/301) | – | – |
| 5 | Kontolöschung ohne Verschiebung | gemergt | [#302](https://github.com/Jannik96D/bordkasse-public/pull/302) | 0063 (auf Prod eingespielt 2026-11-26) | erledigt |
| 6 | Erzwungene Löschung nur Eigentümer | PR offen | [#304](https://github.com/Jannik96D/bordkasse-public/pull/304) | – | – |
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
| `DISABLE_SIGNUP` der Supabase-Ressource | **false** (Signup offen, bis Slice 2 umgestellt ist) |
| A Signups nach Provider (`user_signedup`) | 16, alle `email`; 8 im Sep, 8 im Okt 2026 (passt zu Crew-Einladungen) |
| A2 Alter der Audit-Historie | 524 Einträge, 2026-08-05 bis 2026-11-22 |
| B Audit-Aktionen Top 15 | token_refreshed 199, token_revoked 169, user_recovery_requested 74, login 63, user_signedup 16, logout 3 |
| C Konten/Sessions mit Passwort-Login | 16 Konten / 16 Sessions (Sep: 8 verknüpft; Okt: 6 verknüpft, 2 unverknüpft — unauffällig, ggf. nachsehen) |
| D `auth.users` gesamt / unbestätigt | 34 / 1 |
| E Personen mit Konto, aber ohne Törn | 11 (Purge löscht `trip_members`; nicht aussagekräftig) |
| F Auth-Konten ohne Person/`persons_private` | 3, angelegt Mai/Juni 2026 (vor Cutover), ohne Session — Altlasten |
| A3 verknüpfte Konten mit abweichender/fehlender Personen-Adresse | **0** (kein Blocker für Slice 1) |

**Bewertung:** kein Hinweis auf Missbrauch; ausschließen lässt er sich bei den 2 unverknüpften Oktober-Konten mit Passwort-Session nicht. Die Lücke (`DISABLE_SIGNUP=false`) besteht bis Slice 2.
| G je Admin-Adresse (Index): Konto / Passwort-Session / `persons_private` | ausstehend |

Deutet etwas auf Missbrauch, entscheidet der Nutzer über das Sperren betroffener Konten
(`auth.admin.updateUserById(…, { ban_duration })`); Slice 1/2 werden dann sofort gezogen.

## Offene Punkte

- **`/auth/callback` entfernen (aus Slice 2):** Die Route tauscht einen PKCE-Code
  (`POST /auth/v1/token?grant_type=pkce`), das ist seit Slice 2 für den anon-Key
  gesperrt. Es entstehen auch keine PKCE-Codes mehr (Vorlage nutzt `token_hash` →
  `/auth/confirm`, Versand-Clients im impliziten Flow). Route, `PUBLIC_ROUTES`-Eintrag
  in `proxy.ts`, `emailRedirectTo: …/auth/callback` und der Eintrag in
  `ADDITIONAL_REDIRECT_URLS` können in einem eigenen Schritt weg.
- **Rate-Limit für `POST /auth/v1/verify` (aus Slice 2):** Die Route ist bewusst offen
  und hat kein Limit pro Adresse. Slice 2 erhöht die OTP-Länge auf 10 Stellen
  (Brute-Force aussichtslos). Zusätzlich denkbar: Kongs `rate-limiting`-Plugin oder
  `GOTRUE_RATE_LIMIT_VERIFY` mit verlässlichem Client-IP-Header (vorher klären,
  welchen Header Traefik/Kong liefern).
- **Sessions aus der offenen Zeit (aus Slice 2):** Die Kong-Sperre beendet keine
  bestehenden Sessions. Die 2 unverknüpften Oktober-Konten mit Passwort-Session
  (Lagebild C) prüfen und ggf. Sessions widerrufen/Konten löschen (🖐, Nutzer).

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
