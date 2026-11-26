# Bordkasse — Sicherheitsrunde 2026-11: Login, Identität, Geldintegrität, Härtung

> **Beim Ausführen:** dieses Dokument liegt als `docs/security-audit-2026-11-PLAN.md` im Repo,
> begleitet von `docs/security-audit-2026-11-PROGRESS.md` (Zustandsdokument und Bootstrap-Quelle
> für Folgesessions; wird mit Slice 0 angelegt und nach **jedem** gemergten Slice im selben PR
> fortgeschrieben).

## Context

Grundlage ist der **Security-Audit vom 2026-11-26**: vier unabhängige Leseläufe über `webapp/`
(Login/Session/Header, Server-Actions/Autorisierung, Datenbank/RLS/Self-Host, übrige
Angriffsfläche inkl. Mails, Cron, CI, Secrets), dazu `pnpm audit --prod` und ein Blick auf die
öffentlich ausgelieferten Header der Produktion. Jeder Lauf hatte die Auflage, nur am Quelltext
belegte Befunde mit konkretem Angriffspfad zu melden. Die schweren Befunde sind von Hand im Code
nachgeprüft, der Plan selbst wurde einmal unabhängig gegrillt (siehe „Grill-Runde 1").
**Nichts davon ist gegen die Produktion ausprobiert.**

Ergebnis: **1 kritischer Befund, 1 hoher, 6 mittlere, ~14 niedrige bzw. Härtungen.** Keine
Secrets im Repo oder in der Git-Historie, kein Schreibpfad über PostgREST, kein anonymer
Lesezugriff auf App-Daten.

Die drei Erkenntnisse, die den Zuschnitt bestimmen:

**1. Die Schwachstelle sitzt vor der App, nicht in ihr.** Die Login-Whitelist
(`isEmailAllowedToSignIn`) schützt nur den Weg über `/login`. GoTrue ist über Kong mit dem
öffentlichen anon-Key direkt erreichbar. In der Vorlage `supabase/self-host/.env.example:41`
steht `DISABLE_SIGNUP=false`, dazu `GOTRUE_MAILER_AUTOCONFIRM: "true"`
(`docker-compose.yml:176`). Damit liefert `POST /auth/v1/signup` mit einer **fremden** E-Mail
sofort eine Session, und `PUT /auth/v1/user {email}` übernimmt eine E-Mail-Änderung ohne
Bestätigung. `get-current-person.ts:77-105` verknüpft jede Session allein über `user.email` mit
der passenden Ghost-Person, und Schritt 3 (`:110-141`) legt für **jedes** Auth-Konto eine Person
an. Betroffen ist jede Adresse in `persons_private` ohne Auth-Konto: von Admins angelegte Skipper
(`createTrip` mit `skipper_email`, ohne Einladung), Ghosts mit nachträglich geänderter E-Mail
(Einladung nur bei `isFirstEmail`) und noch nie benutzte `ADMIN_EMAILS`-Adressen. Ob die
Produktion so konfiguriert ist, ist **nicht belegt** (Slice 0).

**2. Die Identität einer Person ist global, ihre Verwaltung lokal.** Eine Person kann in Törns
mehrerer Skipper sein (gewollt), aber jeder dieser Skipper darf ihre E-Mail ändern
(`trip-members.ts:693-694`). Die Cross-Trip-Prüfung des Merge-Pfads (`:658-675`) fehlt für den
einfachen Änderungspfad. Dieselbe Klasse wie F1 der vorigen Runde, nur ohne UUID.

**3. Mitgliedschaft und Trinker-Flag sind Geld.** Bei „Gleichmäßig", „An Bord", „Zeitanteilig"
und „An Alle"-Gutschriften leitet `v_transaction_shares` die Anteile allein aus `trip_members`
ab, der Alkoholanteil aus `COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE)`
(`0032_balances_filter_deleted.sql:44`). Jeder Pfad, der eine Mitgliedschaft löscht, ein Mitglied
hinzufügt, Anwesenheit oder das **Personen**-Flag `is_alcoholic` ändert, verteilt rückwirkend
Geld um. Die Kontolöschung tut beides (löscht Mitgliedschaften reiner Mitesser, setzt
`persons.is_alcoholic = FALSE`), `updateProfile` lässt jeden nach dem Törn „trinke nicht"
setzen, und fast keiner dieser Pfade setzt den „Bilanz geändert"-Marker.

## Entschieden (Nutzer, 2026-11-26)

| Frage | Entscheidung |
| --- | --- |
| Umfang | **Alle Befunde in einen Plan**, gestaffelt nach Schwere; Signup-Lücke und Ghost-Übernahme werden gefixt |
| Geteilte Personen | **Gewollt** — eine Person darf in Törns verschiedener Skipper sein; der Fix sperrt nur das Ändern von Name/E-Mail, nicht das Teilen |
| Merge | **Unverändert:** jeder `gh pr merge` braucht ein frisches Ja des Nutzers pro PR |
| Ausführung | **Neue Session**, ein Orchestrator setzt Slice für Slice mit Subagenten um (Kick-off-Prompt in `docs/security-audit-2026-11-KICKOFF.md`) |

**Noch zu entscheiden** (siehe „Offene Punkte"): Zuständigkeit bei geteilten Personen (Slice 3,
Vorschlag liegt vor); Länge des Session-Timeouts (Slice 2); Verschlüsselungswerkzeug der Backups
(Slice 15).

## Arbeitsweise dieser Runde

Pro Slice: Branch frisch von `main` → implementieren → `pnpm typecheck && pnpm lint && pnpm test`
(bei Migrationen zusätzlich `pnpm test:db`) → **Grill durch einen unabhängigen Subagenten ohne
Konversationskontext** (Pflicht laut `CLAUDE.md`; Opus für Slices mit Auth, Migration oder
Geldlogik, Sonnet sonst) → jeden neuen Test **mutieren** (muss ohne den Fix rot werden;
Rücksetzen per Datei-Backup, **nie** `git checkout -- .`) → PR öffnen → grüne CI → **Merge nur
nach ausdrücklichem Ja des Nutzers**.

- **Ein PR pro Slice.** Doku im selben PR: `CLAUDE.md`, die betroffene Spec in `docs/`
  (`self-hosting.md`, `prepayments.md`, `calculation-rules.md`) und das Progress-Dokument.
- **Migration vor App-Deploy:** Coolify deployt beim Merge sofort. Jede Migration wird auf Prod
  eingespielt, **bevor** gemergt wird (das macht der Nutzer, z. B. per temporärem Scheduled Task
  wie in `CLAUDE.md` beschrieben), danach `NOTIFY pgrst, 'reload schema'`. Ein
  Coolify-Redeploy spielt keine Migration ein. Neue Rückgabecodes von SQL-Funktionen müssen von
  der **alten** App generisch behandelt werden (Migration läuft vor dem App-Deploy).
- **🖐 = braucht einen Eingriff des Nutzers** außerhalb des Codes (Coolify-Variable, Neustart der
  Supabase-Ressource, Server, Absprache mit dem Server-Betreiber). Diese Slices werden vollständig
  vorbereitet; erledigt sind sie erst nach dem Eingriff.
- **Nichts gegen Produktion ausprobieren.** Angriffe werden lokal nachgestellt. ⚠️ `supabase
  start` lokal ist **nicht** der Prod-Stack: kein Kong-Config aus `kong.yml`, andere GoTrue-Version
  als `docker-compose.yml:127` (v2.189), kein gebrandetes Template. Was auf Kong oder die exakte
  GoTrue-Version ankommt, wird gegen den Self-Host-Stack (`webapp/supabase/self-host`, lokal per
  `docker compose`) belegt oder im PR ausdrücklich als „nicht lokal belegt" benannt.
- **Mac-Last:** lokale Container-Starts (colima, supabase) als je eigenes abgeschlossenes
  Kommando, kein Background-Polling über Turns, kein `sleep`.

## Prämissen, die die Recherche korrigiert hat

1. **„Supabase wird nicht mehr genutzt" trifft nur auf den Anbieter zu.** Der Supabase-Stack läuft
   selbst gehostet **in Coolify**; GoTrue, Kong und PostgREST sind öffentlich unter
   `sb.bordkasse.dieter.ms` erreichbar (aus dem CSP-Header der Produktion).
2. **`GOTRUE_MAILER_AUTOCONFIRM` muss `true` bleiben** (bei `false` bekommen Neu-Eingeladene eine
   englische Signup-Bestätigung statt des Magic-Links). Autoconfirm ist zugleich die Ursache, dass
   `PUT /auth/v1/user {email}` ohne Bestätigung greift — deshalb wird dieser Endpunkt in Kong
   gesperrt (Slice 2), statt Autoconfirm abzuschalten.
3. **`DISABLE_SIGNUP=true` allein bricht Einladungen.** `lib/auth/invite.ts:47` und die
   Login-Action verlassen sich darauf, dass `signInWithOtp` Konten anlegt. Erst muss der Code
   Konten selbst anlegen (Slice 1), dann wird umgestellt (Slice 2).
4. **`persons` ist nicht mehr für jeden lesbar.** `CLAUDE.md` begründet F1 noch mit
   `persons … USING (TRUE)`; seit `0013_privacy.sql:52-63` gilt `persons_visible_to_crew_or_self`.
5. **Die drei `"use server"`-Treffer außerhalb von `lib/actions`** sind nur Kommentare.
6. **Die drei `pnpm audit`-Befunde sind hier nicht ausnutzbar** (`sharp` ohne `remotePatterns`;
   `nanoid`, `source-map-js` nur im Build). Ein Update ist Hygiene.
7. **Das App-Rate-Limit schützt GoTrue nicht**, und `GOTRUE_RATE_LIMIT_HEADER` hilft auch nicht:
   `RATE_LIMIT_EMAIL_SENT` ist ein **globales** Kontingent, und alle App-Aufrufe kommen über
   dieselbe Server-IP. Nur das Schließen des Eingangs (Slice 2) wirkt.
8. **Die Vorlage nutzt `token_hash` → `/auth/confirm` → `/auth/verify`.** `/auth/callback`
   (PKCE-Code) wird von der aktuellen Vorlage nicht mehr erzeugt.

## Grill-Runde 1 (2026-11-26) — was sich geändert hat

Der erste Entwurf hatte sieben blockierende Fehler. Festgehalten, weil jeder davon eine
naheliegende Fehlannahme ist:

- **Der `amr`-Check hätte nichts geschützt.** Ein eingeladenes Crewmitglied kann seinen eigenen
  `token_hash` direkt an das offene `POST /auth/v1/verify` schicken (`kong.yml:84`), bekommt eine
  `otp`-Session, die die App nie gesehen hat, ändert per `PUT /user` die Adresse auf eine fremde
  Ghost-Adresse — `amr` bleibt `otp`. Ersetzt durch einen **serverseitigen Anker** in
  `app_metadata` (Slice 1) plus Kong-Sperre (Slice 2).
- **Schritt 3 von `getCurrentPerson` war übersehen** (Person für jedes Konto, E-Mail wird auch bei
  gescheitertem Insert zurückgegeben → `isAdmin` im ersten Request wahr).
- **Unbestätigte Bestandskonten** würden nach `DISABLE_SIGNUP=true` ausgesperrt (GoTrue behandelt
  `/otp` für unbestätigte Konten als Signup).
- **`encrypted_password` ist kein Indikator** — GoTrue setzt bei OTP-Neuanlage ein zufälliges
  Passwort.
- **Kontolöschung setzt `is_alcoholic = FALSE`** und verschiebt damit Alkoholanteile auch dort,
  wo die Mitgliedschaft bleibt; „An Alle"-Gutschriften hängen ebenfalls an der Mitgliedschaft.
- **Die Login-CSRF-Anzeige wäre fälschbar gewesen** (`email` kommt aus der URL).
- **Per-IP-Limit in GoTrue behebt die Mail-Flut nicht** (globales Kontingent).

---

# Gruppe 1 — Login und Identität (kritisch, hoch)

## Slice 0 🖐 — Lagebild Produktion, Plan ins Repo · Haiku

**Ziel.** Wissen, ob die Lücke in Produktion offen ist und ob sie genutzt wurde, bevor Code
geändert wird. Dieser PR bringt außerdem Plan und Progress-Dokument nach `main`.

**Zu tun.**
1. 🖐 Nutzer liest in Coolify `DISABLE_SIGNUP` der Supabase-Ressource ab.
2. 🖐 Lesende Abfragen als temporärer Scheduled Task im `db`-Container (Muster aus `CLAUDE.md`,
   **nur `SELECT`**, Ausgabe nur als Zahlen, keine Adressen):
   - `auth.audit_log_entries`: Anzahl Einträge mit Aktion `user_signedup`, aufgeteilt nach
     Provider/Traits (direkter Signup vs. OTP), und Logins mit Passwort-Grant.
   - `auth.mfa_amr_claims` mit `authentication_method = 'password'` (hängt an Sessions; leere
     Historie ist kein Entlastungsbeweis).
   - `auth.users WHERE email_confirmed_at IS NULL` (Voraussetzung für Slice 2, siehe dort).
   - Personen mit `auth_user_id`, deren `id` in **keiner** `trip_members`-Zeile steht und deren
     E-Mail nicht in `ADMIN_EMAILS` ist (Fremdkonten aus Schritt 3).
   - Für jede `ADMIN_EMAILS`-Adresse: existiert ein Auth-Konto, und ist es per Signup/Passwort
     entstanden? (Ja/Nein je Adresse, ohne die Adresse auszugeben.)
3. Doku-Korrektur aus Prämisse 4 in `CLAUDE.md`; Plan + Progress-Dokument committen.

**Akzeptanz:** Werte im Progress-Dokument. Deutet etwas auf Missbrauch, entscheidet der Nutzer
über das Sperren betroffener Konten (`auth.admin.updateUserById(…, { ban_duration })`), und
Slice 1/2 werden sofort gezogen.

## Slice 1 — Konten nur serverseitig, mit Anker; Ghost-Verknüpfung nur mit Anker · Opus

**Der Befund.** Context 1. Konten entstehen als Nebenwirkung von `signInWithOtp`; die
Verknüpfung mit einer Ghost-Person vertraut `user.email`, die über GoTrue änderbar ist; Schritt 3
legt für jedes Konto eine Person an.

**Der Fix.**
- Neuer Helfer `lib/auth/ensure-auth-user.ts` (`server-only`):
  - `auth.admin.createUser({ email, email_confirm: true, app_metadata: { bordkasse_email: email } })`.
  - Bei Fehlercode `email_exists` (über `error.code`, nicht über den Text): Nutzer-ID ermitteln,
    dann `auth.admin.updateUserById(id, { email_confirm: true, app_metadata: { bordkasse_email: email } })`
    — bestätigt unbestätigte Bestandskonten (sonst Aussperrung nach Slice 2) und setzt den Anker.
  - Jeder andere Fehler: fail-closed, neutrale Meldung, geloggt nur der Fehlercode.
  - `app_metadata` kann nur der Service-Role-Key schreiben, nie der Nutzer selbst.
- Aufgerufen in `signInWithMagicLink` **nach** Rate-Limit und Whitelist, **vor** dem OTP-Versand,
  und in `sendInvitationMagicLink` (deckt alle drei Aufrufer ab: `trip-members.ts:179`, `:711`,
  `prepayments.ts:1654`).
- Beide OTP-Aufrufe mit `shouldCreateUser: false`, über einen cookielosen Client (der
  Cookie-Client in der Login-Action wird für den OTP-Versand nicht gebraucht; die Session entsteht
  erst in `/auth/verify`).
- `getCurrentPerson`:
  - Schritt 2 (Ghost verknüpfen) nur, wenn `user.app_metadata.bordkasse_email` case-insensitiv
    gleich `user.email` ist.
  - Schritt 3 (neue Person anlegen) nur für Adressen aus `ADMIN_EMAILS` (der einzige legitime
    Fall: Erst-Login eines Admins ohne Einladung), sonst `null`. Scheitert der
    `persons_private`-Insert, wird `null` zurückgegeben (heute `email: user.email`).
- Einmaliger Backfill des Ankers für **bestehende** Konten: nur für Konten, die bereits mit einer
  Person verknüpft sind (`persons.auth_user_id`) **oder** deren Adresse in `persons_private`
  steht — und erst nachdem Slice 0 keinen Missbrauch gezeigt hat (sonst würde der Backfill ein
  Angreiferkonto legitimieren). Als SQL-Skript im PR, 🖐 vom Nutzer auf Prod ausgeführt, als
  `supabase_auth_admin`.

**Akzeptanz:**
- Vitest (mutationsgeprüft), Mocks in `__tests__/login-actions.test.ts` erweitern: Konto wird vor
  dem OTP angelegt; `email_exists` → `updateUserById` mit Bestätigung und Anker, dann OTP; anderer
  Fehler → keine Mail, Fehler; `shouldCreateUser: false` in beiden Pfaden; Rate-Limit-Treffer ruft
  `createUser` nicht. `getCurrentPerson`: ohne Anker kein Ghost-Link; Anker ≠ `user.email` kein
  Link; Schritt 3 für Nicht-Admin → `null`; `privErr` → `null`.
- Lokal mit `enable_signup = false`: Login einer bekannten Person, Erst-Login eines neu
  eingeladenen Ghosts, Erst-Login einer `ADMIN_EMAILS`-Adresse, Login eines **unbestätigten**
  Bestandskontos. Mailpit zeigt jeweils eine **Magic-Link**-Mail, keine „Confirm Signup"
  (lokal gibt es kein gebrandetes Template; alternativ `content_path` in `config.toml` auf
  `public/email/magic-link.html` setzen). Abweichende lokale GoTrue-Version im PR nennen.
- Deploybar **ohne** Slice 2.

## Slice 2 🖐 — GoTrue-Eingang schließen: Kong-Allowlist, Signup aus, Sitzungsdauer · Opus

**Voraussetzung:** Slice 1 gemergt und deployt, Anker-Backfill gelaufen.

**Der Befund.** Context 1 und Prämisse 7: `/auth/v1/*` ist für den anon-Consumer offen —
`signup`, `otp`, `magiclink`, `recover`, `resend`, `PUT /user`, Passwort-Grant. Damit:
Kontoanlage ohne Postfach, E-Mail-Änderung ohne Bestätigung, Passwort-Login am Magic-Link vorbei,
und eine OTP-Flut, die das globale Mail-Kontingent (`RATE_LIMIT_EMAIL_SENT: 100`) erschöpft.
Refresh-Tokens laufen unbegrenzt (`GOTRUE_SESSIONS_*` nicht gesetzt).

**Der Fix.**
- **Kong: Allowlist statt Sperrliste** für den anon-Consumer auf `/auth/v1/`:
  - erlaubt: `POST /token` nur mit `grant_type=refresh_token`, `GET /user`, `POST /logout`, die
    bestehenden offenen Routen `verify`, `callback`, `authorize`, `jwks`, `sso/*`;
  - alles andere → 403 per `request-termination`.
  - Der `admin`-Consumer (Service-Role-Key) behält vollen Zugriff — darüber laufen OTP-Versand und
    Kontoanlage der App. Dafür in Slice 2 den OTP-Versand in `ensure-auth-user`/Login/Einladung auf
    einen Client mit **Service-Role-Key** umstellen (cookielos, `server-only`).
  - ⚠️ `KONG_ROUTER_FLAVOR: expressions` (`docker-compose.yml:428`): neue Routen als `expression`
    mit expliziter `priority` schreiben; ob `http.queries.grant_type` und Methoden-Matching so
    funktionieren, **gegen den Self-Host-Stack per `curl` belegen**.
  - Vorher per Grep belegen, welche GoTrue-Endpunkte die App und der Browser-Client wirklich
    nutzen (`supabase.auth.*`-Aufrufe in `app/`, `components/`, `lib/`).
- **Env (🖐, Coolify, Neustart der Supabase-Ressource):** `DISABLE_SIGNUP=true`;
  `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` (Vorschlag 90 Tage — Crew öffnet die App wenige Male im
  Jahr). Repo: `.env.example` (Wert + korrigierter Kommentar, der heutige „Schutz ist die Whitelist
  im App-Layer" ist der Befund), `docker-compose.yml`, `supabase/config.toml`
  (`enable_signup = false` unter `[auth]` und `[auth.email]`).
- `/auth/callback` prüfen: wird er noch irgendwo erzeugt? Wenn nein, im Plan unter „Offene
  Punkte" vormerken, nicht in diesem Slice entfernen.

**Akzeptanz (gegen den Self-Host-Stack, je einmal ohne und mit Fix, beides im PR belegt):**
- `POST /auth/v1/signup` mit anon-Key → keine Session;
- `PUT /auth/v1/user {email}` und `{password}` mit Nutzer-JWT → 403;
- `POST /auth/v1/token?grant_type=password` → 403; `refresh_token` → funktioniert;
- 120× `POST /auth/v1/otp` mit anon-Key → 403, Login über `/login` danach weiter möglich;
- Realtime, Logout und Token-Refresh im Browser funktionieren.
- Nach dem Prod-Umstellen (Nutzer): Login über die Domain, Erst-Einladung einer Testadresse mit
  gebrandeter Mail. `docs/self-hosting.md` nennt die Allowlist, die Variablen und die Reihenfolge
  Slice 1 → Backfill → Slice 2.

## Slice 3 — Geteilte Personen: Name/E-Mail nur mit Zuständigkeit für alle Törns · Sonnet

**Der Befund.** `updateMember` (beginnt `trip-members.ts:509`, E-Mail-Upsert `:693-694`) ändert
Name und E-Mail einer Ghost-Person, ohne zu prüfen, ob sie in einem Törn eines **anderen**
Skippers ist. Angriff: Skipper A lädt die bekannte E-Mail einer nie eingeloggten Person aus Törn Y
in Törn X ein (`inviteMember` übernimmt die Person, `:72-84`), ändert die E-Mail auf seine eigene,
loggt sich ein und ist diese Person in Y. Gefährlichste Variante: geteilter Ghost **ohne**
E-Mail, dem A eine Adresse gibt. Harmlose Variante: ein Tippfehler sperrt die Person aus allen
Törns aus. Andere Pfade ändern Name/E-Mail bestehender Personen nicht (`inviteMember`,
`replaceMember` `prepayments.ts:1122-1206`); der Merge-Helfer prüft beide Richtungen bereits.

**Der Fix.**
- Member-Lookup liest zusätzlich `persons.display_name`; die bisherige E-Mail (`priorPriv`) wird
  **vor** dem ersten Write gelesen.
- „Geändert": Name ≠ bisheriger Name, E-Mail ≠ bisherige (case-insensitiv); **keine bisherige
  E-Mail + neue Adresse zählt als Änderung**. Das Formular schickt Name und E-Mail einer
  Ghost-Person bei **jedem** Speichern mit — ohne Vergleich wäre jede Anwesenheits-Änderung
  blockiert.
- Bei Änderung: alle anderen Törns der Person ermitteln; ist der Ausführende nicht globaler Admin
  und nicht in **jedem** davon Skipper (`trips.skipper_id` oder `trip_members.is_skipper`), wird
  die **gesamte** Aktion abgelehnt, bevor irgendetwas geschrieben wird. Lesefehler → fail-closed.
- Unveränderte Werte werden nicht neu geschrieben (das Audit-Log notiert heute bei jedem Speichern
  `name_changed: true`).
- Meldung ohne fremde Namen.

**Akzeptanz (Vitest, mutationsgeprüft):** fremder Skipper + neue E-Mail → abgelehnt, kein Write;
fremder Skipper + erste E-Mail für Ghost ohne Adresse → abgelehnt; + neuer Name → abgelehnt;
unveränderte Werte + neue Anwesenheit → erlaubt; nur eigene Törns → erlaubt; Admin → erlaubt;
Lesefehler → abgelehnt. Die positionellen Merge-Tests in `trip-member-actions.test.ts` werden an
die neue Abfragereihenfolge angepasst, nicht gelockert.

## Slice 4 — Login-CSRF: `/auth/verify` prüft, für wen der Link gilt · Sonnet

**Der Befund.** `/auth/confirm?token_hash=<Token des Angreifers>` loggt ein Opfer nach einem Klick
in das Konto des Angreifers ein (Same-Origin-POST, der Origin-Check greift nicht). Eine Anzeige
der Adresse allein hilft nicht: der `email`-Parameter kommt aus der URL und ist fälschbar.

**Der Fix.** `/auth/verify` vergleicht nach `verifyOtp` die Adresse des Session-Nutzers mit dem
`email`-Parameter; bei Abweichung oder fehlendem Parameter `signOut` und Redirect auf `/login`
mit Fehlercode. Erst dann zeigt `/auth/confirm` die Adresse an („Du meldest dich an als …").
Der „Neuen Link senden"-Pfad bei abgelaufenem Link bleibt unverändert.

**Akzeptanz:** Route-Test im Stil von `__tests__/auth-verify-route.test.ts`: abweichender
Parameter → keine Session-Cookies in der Response; passender → Session; fehlender → keine Session.

---

# Gruppe 2 — Geld und Daten (mittel)

## Slice 5 — Kontolöschung darf keine Anteile verschieben · Opus · Migration 0063

**Der Befund.**
- (a) `delete_my_account()` ist per `GRANT … TO authenticated` (0021/0038/0043) direkt über
  `POST /rest/v1/rpc/delete_my_account` aufrufbar — ein Seiteneingang ohne Löschen von
  `auth.users` und ohne App-Logging. Die App nutzt seit 0051 `admin_delete_person_data`.
- (b) `admin_delete_person_data` löscht `trip_members`, wenn keine
  `paid_by`/`credit_*`/`transaction_participants`-Spur existiert; die Sperre
  `has_active_bookings` gilt nur für `end_date >= CURRENT_DATE`. Ein reiner Mitesser verschwindet
  aus `v_balances`, sein Anteil wandert rückwirkend auf die Crew — auch nach der Abrechnung.
- (c) Die Funktion setzt `persons.is_alcoholic = FALSE` (`0061:326-329`). Über den `COALESCE`
  verschiebt das den Alkoholanteil in jedem Törn, in dem `trip_members.is_alcoholic` `NULL` ist —
  auch bei Personen **mit** Buchungen, deren Mitgliedschaft heute bleibt.

**Der Fix.**
- `DROP FUNCTION delete_my_account()` (kein Aufrufer mehr; sonst müsste jede Änderung gespiegelt
  werden). Betroffene pgTAP-Abschnitte anpassen: `prepayment_item_reminder_log_test.sql:159-168`,
  `purge_with_item_self_credit_test.sql:165-217`.
- `admin_delete_person_data`:
  - **Laufender oder künftiger Törn** (`end_date >= CURRENT_DATE`, nicht gepurged), in dem die
    Person Mitglied ist → neuer Rückgabecode `is_active_member`, nichts wird gelöscht (ein
    anonymisiertes Mitglied würde sonst an allen künftigen „Gleichmäßig"-Ausgaben beteiligt).
  - **Beendeter Törn mit irgendeiner** nicht gelöschten `transactions`-Zeile → Mitgliedschaft
    bleibt, Person wird nur anonymisiert.
  - Törn ohne Buchungen → Mitgliedschaft wird wie heute entfernt.
  - Vor dem Zurücksetzen von `persons.is_alcoholic`:
    `UPDATE trip_members SET is_alcoholic = COALESCE(is_alcoholic, <bisheriger Personenwert>)`
    für alle verbleibenden Mitgliedschaften.
- App: `is_active_member` in `app/profile/actions.ts:184-201` und `delete-account-block.tsx`
  übersetzen. Die **alte** App muss den unbekannten Code generisch als Fehler anzeigen (prüfen,
  weil die Migration vorher live geht).

**Akzeptanz (pgTAP, gegen die alte Funktion rot):** Mitesser mit nur `equal`-Anteilen in
beendetem Törn löscht → `v_balances` unverändert, Σ = 0; Trinker mit `trip_members.is_alcoholic =
NULL` und `persons.is_alcoholic = TRUE` löscht → Saldo vorher = nachher; Mitglied eines laufenden
Törns → `is_active_member`, nichts geändert; Törn ohne Buchungen → Mitgliedschaft entfernt;
`delete_my_account` existiert nicht mehr. Vitest für die Übersetzung des neuen Codes.

## Slice 6 — Erzwungene Datenlöschung nur durch den Törn-Eigentümer · Sonnet

**Der Befund.** `purgeTripNow(tripId, force)` (`trips.ts:370-371`) prüft nur
`requireSkipperOrAdmin`. `force` überspringt Frist und Abrechnung; übrig bleibt
`all_debts_settled`, das Anzahlungs- und Posten-Salden ausfiltert. Ein Co-Skipper kann einen Törn
in der Anzahlungsphase unwiderruflich anonymisieren (`deleteTrip` wurde deshalb schon auf
`requireTripOwnerOrAdmin` beschränkt).

**Der Fix.** `force === true` verlangt `requireTripOwnerOrAdmin`. Zusätzlich blockt `force`,
solange der Anzahlungs-Pool oder ein Posten offene Salden hat (bestehende Queries
`getPrepaymentPoolBalances`, `getItemPotBalances`), fail-closed bei Lesefehler.

**Akzeptanz:** Co-Skipper + `force` → abgelehnt, RPC nicht aufgerufen; Eigentümer + offener Pool →
abgelehnt; Eigentümer, alles ausgeglichen → erlaubt; ohne `force` unverändert.

## Slice 7 — Anzahlungs-Rechte: Ex-Vorstrecker und Posten-Ablehnung · Sonnet

**Der Befund.** (a) `requireSkipperAdminOrAdvancer` (`authz.ts:160-161`) prüft für den
Vorstrecker keine Mitgliedschaft; `removeMember` blockt ihn nicht. Ein entfernter Vorstrecker kann
weiter Zahlungen erfassen (Gutschriften an ein Nicht-Mitglied fallen aus `v_balances`, Σ ≠ 0),
löschen, bestätigen, Erinnerungen schicken. (b) `rejectSelfPayment`
(`prepayments.ts:1918-1946`) prüft weder `tranche_id` noch `type`; ein Vorstrecker ohne
Skipper-Rolle kann offene **Posten**-Selbstmeldungen ablehnen.

**Der Fix.** (a) Advancer-Zweig verlangt eine `trip_members`-Zeile; `removeMember` lehnt ab,
solange die Person `advancer_person_id` ist. (b) `type` ins Select (`:1929`) aufnehmen — ohne das
ist `tx.type` `undefined` und alles würde abgelehnt —, dann
`if (!tx.tranche_id || tx.type !== "credit")` → „nicht gefunden".

**Akzeptanz:** je ein Test, mutationsgeprüft; eine echte Tranchen-Selbstmeldung lässt sich weiter
ablehnen.

## Slice 8 — Kategorie an den Törn binden · Sonnet · Migration 0064

**Der Befund.** `category_id` aus dem Ausgabe-Formular (`transactions.ts:358`, wirksam in
`createExpense`/`updateExpense`/Replay) wird nicht gegen den Törn geprüft; der FK aus 0001 ist
einfach. Eine fremde Kategorie landet beim Purge in `trip_statistics`, ihr Löschen im fremden Törn
nullt die eigene Buchung.

**Der Fix.** App-Check `.eq("trip_id", tripId)` wie in `saveItem`; Composite-FK
`(category_id, trip_id)` nach dem Muster `pi_category_fk` (`0058:124`, `UNIQUE(trip_id, id)`
existiert), mit lesender Prüfung auf Bestandsverletzungen im Migrationskopf.

**Akzeptanz:** Vitest für alle drei Pfade; pgTAP: fremde Kategorie wird abgewiesen.

## Slice 9 — Nachträgliche Saldo-Änderungen: Marker, Trinker-Flag, Doppelversand · Opus

**Der Befund.** Context 3. Folgende Pfade ändern Salden nach der Abrechnung, ohne
`mark_post_settlement_change` (kein Banner, abgehakte Schulden werden still entwertet):
`updateTripDates` (`trips.ts:185-226`, zusätzlich ohne Archiv-Guard), `updateMember`
(Anwesenheit, `is_alcoholic`, `:551-569`), `inviteMember` (neues Mitglied verdünnt rückwirkend
„Gleichmäßig", `:136-152`), `removeMember` (`:415`). `updateProfile`
(`app/profile/actions.ts:39-43`) ändert `persons.is_alcoholic`, das über den `COALESCE` auf
**alle** Törns wirkt: jedes Crewmitglied kann nach dem Törn „trinke nicht" setzen und zahlt
rückwirkend weniger. Außerdem setzen `announceSettlement` und `resendSettlement` ihre Marker erst
**nach** dem Versand (`settlement.ts:188`, `:430`) — ein Doppelklick verschickt alle Mails zweimal.

**Der Fix.**
- Ein Helfer „Salden dieses Törns können sich geändert haben" (ruft
  `mark_post_settlement_change`), aufgerufen von allen genannten Pfaden nach erfolgreichem Write.
- `updateTripDates`: `assertTripNotArchived`.
- `updateProfile`: vor dem Ändern von `persons.is_alcoholic` den bisherigen Wert in
  `trip_members.is_alcoholic` festschreiben, wo dieser `NULL` ist und der Törn begonnen hat oder
  Buchungen trägt; damit wirkt das Profil-Flag nur noch als Vorbelegung für künftige Törns.
- Atomarer Claim vor dem Versand in `announceSettlement` (`UPDATE … WHERE settlement_announced_at
  IS NULL RETURNING`) und `resendSettlement` (Claim auf `changes_pending_since`), Muster
  `crew_notified_at` aus 0062. Ein kompletter Versandfehlschlag bleibt über das
  `settlement_mail_sent_at`-Retry aus 0052 lösbar.

**Akzeptanz:** je Pfad ein Test, dass der Marker gesetzt wird; `updateProfile` nach Törnbeginn
ändert keinen Saldo (Vitest gegen die Logik, pgTAP gegen `v_balances`); zweiter paralleler Aufruf
verschickt nichts; `calculation-rules.md` beschreibt, dass `persons.is_alcoholic` nur noch
Vorbelegung ist.

---

# Gruppe 3 — Missbrauch und Datenreste (niedrig)

## Slice 10 — Mail-Aktionen drosseln, verwaiste Auth-Konten aufräumen · Sonnet

**Der Befund.**
- Keine Aktion, die Mails/Pushs an Dritte auslöst, hat ein Limit: `resendSettlement` („Ausgabe
  anlegen + löschen" setzt den Marker beliebig oft), `toggleDebtSettled` (jedes erneute Setzen
  mailt), `submitSelfPayment` (kein Idempotency-Key), `submitItemSelfPayment`, `inviteMember` +
  `removeMember` im Wechsel (Magic-Links an beliebige Adressen).
- Einladungen legen `auth.users` für beliebige Adressen an; `removeMember`, E-Mail-Änderung und
  Purge löschen das Auth-Konto nie — die Adresse bleibt dauerhaft gespeichert (DSGVO-Rest).
- `app/login/actions.ts:85-88` loggt bei Rate-Limit-Treffern die E-Mail im Klartext.

**Der Fix.** Mindestabstand 1 h für `resendSettlement` (`last_settlement_resend_at` existiert);
`toggleDebtSettled` mailt nur beim Wechsel „offen → bezahlt"; `idempotency_key` für
`submitSelfPayment`; Limit pro (Akteur, Aktion, Törn) für Einladungen über
`bump_login_rate_limit` mit eigenem Schlüsselpräfix. Aufräumen: Auth-Konten ohne verknüpfte
Person **und** ohne `persons_private`-Eintrag werden im täglichen Purge-Cron gelöscht (über die
Admin-API, nicht per SQL). Login-Log ohne Adresse (gekürzter Hash genügt).

**Akzeptanz:** je ein Test; der Kommentar „Spam ist ausgeschlossen" in `settlement.ts` wird
korrigiert; Cron-Response nennt die Zahl aufgeräumter Konten.

## Slice 11 — Keine rohen Fehlertexte an den Client · Haiku

**Der Befund.** Rohe Postgres-/SMTP-Meldungen gehen zurück an den Client:
`app/profile/actions.ts:45`, `trips.ts:102`, `trip-members.ts:101/152/561/579/695/1161`,
`send-prepayment-reminder.ts:178/304` (SMTP-Fehler meist mit Empfängeradresse, an einen
Vorstrecker, der Crew-Adressen sonst nicht sehen darf), `send-prepayment-notices.ts:86`,
`invite.ts:55`.

**Der Fix.** `dbErr(error, "…")` bzw. `safeMailErrorMessage`; Details nur ins Log.

**Akzeptanz:** Test, dass der SMTP-Pfad keine Adresse zurückgibt; Grep im PR auf `error.message`
**und** `${…message}` in Rückgabeobjekten von Actions findet nichts mehr.

## Slice 12 — Geteilte Geräte: Daten der vorherigen Person entfernen · Sonnet

**Der Befund.** `cleanupOnLogout` läuft nur beim Klick auf „Abmelden" (`sign-out-button.tsx:30`).
Nach Kontolöschung, Kontowechsel per neuem Magic-Link oder abgelaufener Session bleiben die
Service-Worker-Caches (Bilanz, Crew, `/profile` mit E-Mail) offline lesbar; das Push-Abo bleibt
der alten Person zugeordnet.

**Der Fix.** (a) `delete-account-block.tsx` ruft `cleanupOnLogout()` vor der Löschung. (b) Der
Client merkt sich die zuletzt eingeloggte `personId`; weicht sie ab, läuft `cleanupOnLogout()`
vor dem ersten Rendern sensibler Daten. (c) `public/sw.js` cacht `/auth/*` und `/profile` nicht.
`CACHE_VERSION` hochzählen.

**Akzeptanz:** Vitest für den Personenwechsel; im Browser geprüft (Cache-Inhalt nach Wechsel leer).

## Slice 13 — Session-Cookies mit `Secure` · Sonnet

**Der Befund.** Keiner der Supabase-Clients setzt `cookieOptions`: `lib/supabase/server.ts`,
`proxy.ts:39-54`, die Route-Handler `auth/verify` und `auth/callback`, und
`lib/supabase/client.ts` (Browser, schreibt beim Token-Refresh per `document.cookie`). Defaults
von `@supabase/ssr`: ohne `Secure`, 400 Tage.

**Der Fix.** Ein gemeinsamer Helfer: serverseitig `secure: true`, wenn
`allowedOriginForHost(host)` (`lib/auth/origin.ts`) einen `https`-Origin liefert (die LAN-IP
steht nicht auf der Allowlist → bleibt wie heute, der LAN-Test über `http` bricht nicht); im
Browser `location.protocol === "https:"`. `httpOnly` bleibt aus (Realtime).

**Akzeptanz:** Tests für Domain (secure) und LAN-IP (nicht secure); Login über die LAN-IP
weiterhin möglich.

## Slice 14 — Realtime-Publikation auf das Nötige verkleinern · Sonnet · Migration 0065

**Der Befund.** Realtime prüft RLS bei DELETE nicht. In der Publikation stehen
`transaction_participants`, `prepayment_plan`, `prepayment_obligations`, `prepayment_tranches`,
`cabin_types`; `RealtimeTrip` (`realtime-trip.tsx:78-92`) abonniert nur `transactions`,
`trip_members`, `settled_debts` — andere Abonnenten gibt es nicht. Über DELETE-Events der
Tabellen mit zusammengesetztem Personen-Schlüssel lässt sich mindestens für jeden eingeloggten
Nutzer eine Zuordnung Törn ↔ Personen-UUID mitschneiden (ob auch `anon`, ist zu prüfen).

**Der Fix.** `ALTER PUBLICATION supabase_realtime DROP TABLE …` für die fünf Tabellen.

**Akzeptanz:** pgTAP prüft die Tabellenliste; Realtime-Toasts funktionieren weiter (Browser).

---

# Gruppe 4 — Betrieb und Härtung

## Slice 15 🖐 — Backups mit Rechten und Verschlüsselung · Sonnet

**Der Befund.** `backup.sh:72-87` schreibt Dumps ohne `umask 077` und unverschlüsselt. Sie
enthalten das `auth`-Schema samt `refresh_tokens`/`sessions` und alle Personendaten, auch bereits
gelöschte, 30 Tage lang plus Auslagerung.

**Der Fix.** `umask 077`; Dump mit einem öffentlichen Schlüssel verschlüsseln, privater Schlüssel
nur offline beim Nutzer. Werkzeug zuerst klären: das Skript läuft im `db`-Container
(`backup.sh:12`), `age` ist im Image `supabase/postgres` vermutlich nicht vorhanden — Alternative
`openssl` (hybrid: zufälliger Schlüssel per RSA-Public-Key verpackt). 🖐 Abstimmung mit dem
Server-Betreiber (Abholung 02:00, Format ändert sich). Restore-Anleitung in
`docs/self-hosting.md` anpassen und **einmal echt durchspielen**. Datenschutzerklärung nennt die
Backup-Aufbewahrung.

**Akzeptanz:** Testlauf erzeugt eine Datei mit Modus `600`, die sich nur mit dem privaten
Schlüssel wiederherstellen lässt.

## Slice 16 — CI mit minimalen Rechten · Haiku

`.github/workflows/webapp-ci.yml`: `permissions: contents: read` auf Workflow-Ebene,
`persist-credentials: false`, Actions per SHA (Dependabot hält sie aktuell). **Akzeptanz:** CI grün.

## Slice 17 — Abhängigkeiten · Haiku

`pnpm audit --prod` meldet `sharp < 0.35.5`, `nanoid`, `source-map-js < 1.2.2`, alle über `next`.
Update bzw. `overrides` in `pnpm-workspace.yaml`. **Akzeptanz:** `pnpm audit --prod` ohne „high",
Build und Tests grün.

## Slice 18 🖐 — DB-Härtung (Sammelslice) · Opus · Migration 0066

Jede für sich heute nicht ausnutzbar:
- **JWT-Secret als DB-Einstellung:** `volumes/db/jwt.sql` setzt `app.settings.jwt_secret`, und
  PostgREST setzt es über `PGRST_APP_SETTINGS_JWT_SECRET` (`docker-compose.yml:238`) in **jeder**
  Anfrage neu — per `current_setting()` für jede Rolle lesbar. Fix: Variable aus der Compose-Datei
  entfernen (🖐 Neustart), danach `ALTER DATABASE postgres RESET "app.settings.jwt_secret"`.
  Realtime nutzt `API_JWT_SECRET` aus der Env (`:290`); vorher per Grep belegen, dass keine
  Funktion die Einstellung liest.
- **Standardrechte:** `REVOKE ALL ON ALL TABLES, ALL FUNCTIONS IN SCHEMA public FROM anon`;
  `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`. Vorher prüfen, ob
  `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` als `postgres` überhaupt läuft (vermutlich
  nicht). Folge-Konvention in `CLAUDE.md`: neue Policy-Helfer brauchen ein explizites
  `GRANT EXECUTE … TO authenticated`, sonst scheitert RLS.
- **View-Konvention:** `CREATE OR REPLACE VIEW … WITH (security_invoker = on)`; der Kommentar in
  `0042:124-126` („behält reloptions bei") ist falsch.

**Akzeptanz:** pgTAP für die Rechte; alle bestehenden Tests grün; PostgREST und Realtime laufen
nach dem Neustart.

---

## Reihenfolge und Modellstufen

Schwere zuerst. Was einen Eingriff des Nutzers braucht, wird vorbereitet und wartet dann; die
übrigen Slices laufen weiter.

| # | Slice | Modell | Migration | 🖐 | hängt an |
| --- | --- | --- | --- | --- | --- |
| 0 | Lagebild Produktion, Plan ins Repo | Haiku | – | ja | – |
| 1 | Konten serverseitig, Anker, Schritt 3 | Opus | – | Backfill | 0 |
| 3 | Geteilte Personen | Sonnet | – | – | – |
| 4 | Login-CSRF in `/auth/verify` | Sonnet | – | – | – |
| 2 | Kong-Allowlist, Signup aus, Sitzungsdauer | Opus | – | ja | 1 + Backfill |
| 5 | Kontolöschung ohne Verschiebung | Opus | 0063 | Migration | – |
| 9 | Nachträgliche Saldo-Änderungen | Opus | – | – | – |
| 6 | Erzwungene Löschung nur Eigentümer | Sonnet | – | – | – |
| 7 | Anzahlungs-Rechte | Sonnet | – | – | – |
| 8 | Kategorie an Törn binden | Sonnet | 0064 | Migration | – |
| 10 | Mail drosseln, Auth-Konten aufräumen | Sonnet | – | – | 1 |
| 11 | Rohe Fehlertexte | Haiku | – | – | – |
| 12 | Geteilte Geräte | Sonnet | – | – | – |
| 13 | Secure-Cookies | Sonnet | – | – | – |
| 14 | Realtime-Publikation | Sonnet | 0065 | Migration | – |
| 15 | Backups | Sonnet | – | ja | – |
| 16 | CI-Rechte | Haiku | – | – | – |
| 17 | Abhängigkeiten | Haiku | – | – | – |
| 18 | DB-Härtung | Opus | 0066 | ja | – |

Slices 3 und 4 berühren andere Dateien als Slice 1 und dürfen parallel laufen. Slices, die
dieselbe Datei ändern, laufen nacheinander: 1 → 10 (`app/login/actions.ts`), 3 → 9 → 10 → 11
(`trip-members.ts`), 5 → 12 (`delete-account-block.tsx`).

## Offene Punkte

- **Zuständigkeit bei geteilten Personen (Slice 3):** Vorschlag „Skipper aller Törns oder Admin".
  Alternative: nur Admin. Entscheidung des Nutzers vor Slice 3.
- **`removeMember` löscht reine Mitesser** und verteilt deren Anteil rückwirkend um
  (`personHasBookingTrace` erkennt sie nicht) — derselbe Befund wie Slice 5, für Skipper statt
  Self-Service. Nicht eingeplant, weil `replaceMember` Modus 2 dafür der vorgesehene Weg ist;
  mindestens eine Warnung im Entfernen-Dialog wäre der kleine Schritt.
- **`/auth/callback`** wird von der Vorlage nicht mehr erzeugt; Entfernen nach Slice 2 prüfen.
- **Login-Enumeration bleibt bewusst offen** (Entscheidung D4 der vorigen Runde).
- **Mehrfach geteilte Ghosts aus früheren Merges** werden nicht nachträglich aufgeräumt.
- **Kontolöschung eines Posten-Empfängers** (`is_active_item_payee`) bleibt unverändert.

## Verifikation

Pro Slice, vor dem PR:

```bash
cd webapp && pnpm typecheck && pnpm lint && pnpm test
```

```bash
cd webapp && pnpm test:db
```

Dann Grill, dann Mutationsprüfung der neuen Tests.

**Slice-spezifisch:**
- **Slice 1:** alle vier Login-Fälle lokal (bekannt, Erst-Einladung, Admin, unbestätigtes
  Bestandskonto); Mailpit zeigt Magic-Link-Mails.
- **Slice 2:** der Angriff wird gegen den Self-Host-Stack einmal ohne, einmal mit Fix nachgestellt
  (`curl`-Protokoll im PR).
- **Slice 3/5:** Tests schlagen ohne den Fix fehl; bei Slice 5 Σ Bilanz = 0 vor und nach.
- **Slice 12/14:** im Browser (Preview) geprüft.

**Manuell in Produktion** nach dem Merge (durch den Nutzer): Login, Erst-Einladung einer
Testadresse, Bilanz-Seite eines laufenden Törns.
