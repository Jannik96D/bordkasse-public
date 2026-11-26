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
| 2 | Kong-Allowlist, Signup aus, Sitzungsdauer | gemergt | [#306](https://github.com/Jannik96D/bordkasse-public/pull/306) | – | erledigt: `DISABLE_SIGNUP=true`, Kong-Allowlist live (2026-11-26) |
| 3 | Geteilte Personen: Name/E-Mail nur mit Zuständigkeit | gemergt | [#300](https://github.com/Jannik96D/bordkasse-public/pull/300) | – | – |
| 4 | Login-CSRF in `/auth/verify` | gemergt | [#301](https://github.com/Jannik96D/bordkasse-public/pull/301) | – | – |
| 5 | Kontolöschung ohne Verschiebung | gemergt | [#302](https://github.com/Jannik96D/bordkasse-public/pull/302) | 0063 (auf Prod eingespielt 2026-11-26) | erledigt |
| 6 | Erzwungene Löschung nur Eigentümer | gemergt | [#304](https://github.com/Jannik96D/bordkasse-public/pull/304) | – | – |
| 7 | Anzahlungs-Rechte | gemergt | [#305](https://github.com/Jannik96D/bordkasse-public/pull/305) | – | – |
| 8 | Kategorie an Törn binden | gemergt | [#307](https://github.com/Jannik96D/bordkasse-public/pull/307) | 0064 | erledigt (0064 auf Prod 2026-11-26) |
| 9 | Nachträgliche Saldo-Änderungen | gemergt | [#311](https://github.com/Jannik96D/bordkasse-public/pull/311) | – | – |
| 10 | Mail drosseln, Auth-Konten aufräumen | gemergt | [#312](https://github.com/Jannik96D/bordkasse-public/pull/312) | – | – (kein Zeitlimit für Update-Mails, bewusst; beim ersten Cron-Lauf werden die 3 Altkonten gelöscht, gewollt) |
| 11 | Rohe Fehlertexte | gemergt | [#315](https://github.com/Jannik96D/bordkasse-public/pull/315) | – | – |
| 12 | Geteilte Geräte | gemergt | [#313](https://github.com/Jannik96D/bordkasse-public/pull/313) | – | – |
| 13 | Secure-Cookies | gemergt | [#310](https://github.com/Jannik96D/bordkasse-public/pull/310) | – | – |
| 14 | Realtime-Publikation | gemergt | [#314](https://github.com/Jannik96D/bordkasse-public/pull/314) | 0065 | erledigt (0065 auf Prod 2026-11-26) |
| 15 | Backups mit Rechten und Verschlüsselung | zurückgestellt | – | – | Entscheidung des Nutzers: erstmal nicht |
| 16 | CI mit minimalen Rechten | gemergt | [#308](https://github.com/Jannik96D/bordkasse-public/pull/308) | – | – |
| 17 | Abhängigkeiten | gemergt | [#309](https://github.com/Jannik96D/bordkasse-public/pull/309) | – | – |
| 18 | DB-Härtung (Sammelslice) | gemergt | [#319](https://github.com/Jannik96D/bordkasse-public/pull/319) | 0066 | erledigt (0066 + JWT-Reset auf Prod, Supabase neu deployt, 2026-11-26) |

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

- **Deploy (aus 2026-11-26):** Auto-Deploy in Coolify greift NICHT, alle Deploys sind manuell.
  Der Build läuft seit dem 2026-11-26 auf GitHub (`.github/workflows/build-image.yml` →
  `ghcr.io/jannik96d/bordkasse-app`); Coolify zieht es über `webapp/Dockerfile.image`
  (`docs/self-hosting.md` „Image aus GitHub Actions“). Zwei Builds auf web-1 hatten den Host
  zuvor eingefroren (RAM).
- **Slice 15 (Backups verschlüsseln)** bewusst zurückgestellt; Entscheidung steht oben
  (`openssl` hybrid, privater Schlüssel offline beim Nutzer).
- **Hilfs-Task in Coolify:** `tmp-apply-0066` (Supabase-Ressource, Zeitplan 1. Januar) ließ sich
  nicht löschen; harmlos/idempotent, von Hand löschen. Der Branch `security/ops-0066` bleibt, solange
  er existiert.

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
