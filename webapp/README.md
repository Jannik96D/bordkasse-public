# Bordkasse Web-App

Next.js 16 + Supabase Web-App-Variante der Bordkasse. Spec: [`../docs/web-app-spec.md`](../docs/web-app-spec.md).

## Features

- **Auth:** Magic-Link per E-Mail (Token-Hash-Flow, Single-Use, 60 Min TTL).
  - **Whitelist-Schutz:** Magic-Link wird nur an E-Mails verschickt, die in `ADMIN_EMAILS` stehen oder bereits in `persons_private` (= per Skipper-Einladung hinterlegt) — Fremde sehen eine Fehlermeldung, es wird kein Auth-User produziert.
  - **Klick-Bestätigungsseite:** `/auth/confirm` ist eine Page mit „Jetzt einloggen"-Button → POST nach `/auth/verify` → `verifyOtp`. Schützt vor Link-Scannern (Outlook Safe Links, Gmail Spam-Filter), die GET-URLs in eingehenden Mails automatisch im Hintergrund aufrufen würden.
  - **Auto-Resend bei abgelaufenem Link:** die Empfänger-E-Mail wird durch den Flow durchgereicht (`&email={{ .Email }}` im Magic-Link-Template). Bei `otp_expired`/`verify_failed` zeigt die Login-Page direkt einen „Neuen Link an X senden"-Button.
  - **Auto-Invite-Mail:** wenn ein Skipper eine neue Person zur Crew hinzufügt, geht automatisch ein Magic-Link an die E-Mail.
  - **Resend-Button** nach 30 s im normalen Login-Flow.
- **Rollen:**
  - **Admin** — über `ADMIN_EMAILS` (Env-Var, Komma-separiert). Darf Törns anlegen + alle Trips verwalten + Crew bearbeiten + löschen. Sieht ALLE Trips (Service-Role-Read-Bypass via `lib/supabase/read-client.ts`), auch fremde.
  - **Skipper** — Original-Anleger eines Törns (`trips.skipper_id`); kann nicht degradiert oder entfernt werden.
  - **Co-Skipper** — `trip_members.is_skipper = TRUE`. Darf alles, was der Skipper darf, außer der Original-Skipper-Slot.
  - **Crew-Member** — `trip_members`-Eintrag. Darf Buchungen erfassen + eigene Schulden abhaken; sieht Bilanz/Schulden/Statistik.
- **Privacy-Split (Migration 0013):** `persons.display_name` ist öffentlich (Vorname + ggf. Initial), darf keine Nachnamen tragen. `persons_private.last_name` + `persons_private.email` (CITEXT) — sichtbar via RLS nur für Self oder Trip-Skipper der eigenen Crew.
- **Aufteilungslogiken:** Gleichmäßig, An Bord, Zeitanteilig, Individuell, **Pro Person** + Alkohol-Modifikator (siehe [`docs/calculation-rules.md`](../docs/calculation-rules.md)). „Pro Person" akzeptiert Mini-Rechner-Eingaben (`3 + 17`) und unterstützt ein **Trinkgeld**-Feld mit wählbarer Verteilung — `proportional` zum Rechnungsbetrag (Default) oder `equal` auf alle Beteiligten gleich (Feld `transactions.tip_distribution`).
- **Buchungen:** erfassen + nachträglich **bearbeiten** unter `/trips/[id]/transactions/[txId]/edit` (Skipper, Admin oder Ersteller dürfen ändern). Liste mit clientseitigem Suchfeld (ab > 4 Einträge sichtbar), Aufteilung als Tab-Row, „Individuell"-Crew als Chips.
  - **Einheitliche Picker** mit Smart-Position: Kategorie- und Personen-Auswahl als Custom-Dropdowns, die nach oben aufklappen wenn unten kein Platz ist, mit „(du)"-Marker für den eingeloggten User.
  - **Toast nach Speichern:** `?toast=…`-Redirect zeigt eine grüne Erfolgs-Meldung („Ausgabe erfasst.", „Gutschrift aktualisiert." etc.) und säubert die URL automatisch.
  - **Scroll-to-Error + Feld-Highlight:** bei Validierungs-Fehlern scrollt die Form zum betroffenen Feld und markiert es rot — die Crew muss nicht raten, was fehlt.
  - **Settings sind für alle Crew-Mitglieder sichtbar** (read-only). Crew kann die Liste der Mitglieder und Kategorien einsehen; Edit-Buttons sind nur für Skipper/Admin aktiv.
- **Gutschriften:** direkt oder „An Alle" — ausschließlich von Skippern/Admins erfassbar. „An Alle" verlangt mindestens 2 Crew-Mitglieder (sonst lässt sich die Bilanz nicht ausgleichen).
- **Bilanz & Schulden:** Live aus SQL-Views (`v_balances`, `v_transaction_shares`); `simplify_debts()` als Greedy-Algorithmus für minimale Überweisungen.
- **Bezahlt-Status der Schulden:** Crew-weit synchronisiert in `settled_debts`; nur Schuldner, Gläubiger oder Admin dürfen das Häkchen toggeln. Sobald jemand ein Häkchen setzt, gehen automatisch zwei Mails raus — an Schuldner UND Gläubiger. Der Wortlaut hängt davon ab, **wer** das Häkchen tatsächlich gesetzt hat (sechs Varianten, gesteuert über `actorRole` im Template):
  - **Schuldner hakt selbst ab:** Schuldner bekommt „du hast deine Zahlung gemeldet", Gläubiger „X hat seine Zahlung an dich abgehakt".
  - **Gläubiger hakt ab:** Schuldner bekommt „X hat deine Zahlung als erhalten bestätigt", Gläubiger „du hast den Empfang bestätigt".
  - **Admin/Skipper hakt ab:** beide bekommen die neutrale Variante „X hat das in der Bordkasse abgehakt".

  Beim Entfernen des Häkchens wird keine Mail verschickt. Template in `lib/email/debt-settled-template.ts`, Versand in `lib/actions/settled-debts.ts:sendDebtSettledMails` — Mail-Fehler werden geloggt, brechen den Toggle aber nicht ab.
- **Crew-Schutz beim Entfernen:** Personen mit aktiven Buchungen (paid_by / credit_from / credit_to in nicht-soft-deleten Transaktionen) können nicht aus der Crew entfernt werden — Bilanz würde sonst inkonsistent. Skipper muss erst die Buchungen umbuchen (Edit-Form) oder löschen.
- **Kategorien:** pro Trip mit lucide-react-Icon (kuratierte 23-Icon-Whitelist in `lib/categories/icons.ts`). Marineblau-monochrome Strich-Icons im Bottom-Nav-Stil; Picker im Settings-Tab. Default-Liste bei neu angelegten Trips: Lebensmittel, Restaurant, Hafen / Liegeplatz, Aktivitäten, Ausrüstung, Sprit, Yacht, Versicherung, Kaution, Sonstiges (jeweils mit passendem Icon — Map in `DEFAULT_NAME_ICON`).
- **Statistik:** Live-Aggregation pro Trip nach Kategorie + Tag. Tap auf eine Kategorie öffnet die Buchungs-Liste mit dem Kategorie-Namen als Such-Vorbelegung (Drilldown via `?q=…`-Param). Bleibt nach DSGVO-Purge anonymisiert in `trip_statistics` erhalten.
- **PWA:** Service Worker (`public/sw.js`) + IndexedDB-Outbox. Buchungen können offline erfasst werden, werden bei Reconnect automatisch synchronisiert (`lib/offline/sync.ts`). Idempotency-Key auf jeder Buchung verhindert Duplikate.
- **Audit-Log:** jede Schreib-Operation (Trip, Crew, Kategorie, Buchung, Settled-Debt) hinterlässt einen Eintrag in `audit_log`. RLS schränkt Lese-Zugriff auf den Skipper des betroffenen Trips ein.
- **Soft-Delete:** Buchungen werden mit `deleted_at` markiert statt physisch gelöscht. Views/Listen filtern automatisch.
- **DSGVO-Datenlöschung:** Vercel-Cron ruft täglich `/api/cron/purge` → `purge_expired_trip_data()`. Ein Trip wird nur gepurged, wenn drei Bedingungen erfüllt sind: (a) end_date + 30 Tage in der Vergangenheit, (b) Skipper hat die Abrechnung verschickt (`settlement_announced_at`), (c) alle simplified-debts sind in `settled_debts` abgehakt. Trips mit offenen Schulden bleiben für den nächsten Cron-Lauf liegen. Skipper/Admin können den Purge im Trip-Settings-Tab manuell anstoßen (`purge_trip_data(trip_id, force)`); Force-Modus überspringt Retention-Frist + Settlement-Flag, NIE aber die Schulden-Prüfung. Auf der Trip-Auswahl-Seite werden überfällige Trips (`end_date + 30 Tage < heute`, noch nicht gepurged) für Skipper/Admin rot markiert + Banner oben. Anonymisiertes Statistik-Aggregat bleibt erhalten.
- **Hosting-Region:** Server-Functions, Server-Actions und Cron laufen auf Vercel in der EU-Region `fra1` (Frankfurt), konfiguriert via `regions: ["fra1"]` in `vercel.json`. Ohne diese Config würde Vercel im US-Default `iad1` laufen. Supabase-DB ebenfalls in Frankfurt (Central EU). Mailserver bei whost.dev (DE).
- **Security-Header:** HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP — gesetzt in [`next.config.ts`](next.config.ts).
- **Crawler-Schutz:** `robots.txt` + `<meta name="robots" content="noindex,nofollow">`.
- **Settlement-Workflow:** Ab dem letzten Törn-Tag sieht der Skipper in der Trip-Übersicht + Schulden-Seite einen Banner „Törn vorbei — Abrechnung verschicken?". Klick auf den Button (`announceSettlement`) berechnet aktuelle Bilanz + simplified-debts, schickt jedem Crew-Mitglied mit hinterlegter Email eine personalisierte HTML-Mail (Saldo + konkrete Zahlungsanweisungen + Link auf die Schulden-Seite zum direkten Abhaken, via SMTP/nodemailer), setzt `trips.settlement_announced_at`. Erst danach sind die Bezahlt-Häkchen in der Schulden-Ansicht freigeschaltet — vorher sehen Crew-Mitglieder einen Hinweis „Skipper schließt die Bordkasse gerade ab". Bei nachträglicher Bearbeitung/Löschung einer Kaution-Buchung leitet die App den Skipper automatisch zur Trip-Übersicht mit prominentem Highlight-Banner, damit die Abrechnung nicht vergessen wird. Mail-Layout 1:1 wie das Magic-Link-Template (Logo, Card auf #FAFBFC, Bordkasse-Farben, Outlook-safe table-Layout). Env-Vars: `SMTP_HOST` / `SMTP_PORT` (587 STARTTLS oder 465 SSL) / `SMTP_USER` / `SMTP_PASS` (dieselben Credentials wie für Supabase-Auth-Mails) + `MAIL_FROM` (z. B. `"Bordkasse <bordkasse@dieter.ms>"`) + `NEXT_PUBLIC_APP_ORIGIN`.
- **Settlement-Update-Mail:** Buchungs-Änderungen nach dem initialen Mailversand (create/update/delete von Expense/Credit) setzen den Marker `trips.changes_pending_since` über den SQL-Helper `mark_post_settlement_change()` (aufgerufen in `lib/actions/transactions.ts`). Solange der Marker gesetzt ist, sieht **jedes Crew-Mitglied** einen gelben Banner „Bilanz hat sich seit der Abrechnung geändert" mit Button „Update-Mail verschicken" — typischerweise löst die Person, die soeben die nachträgliche Buchung erfasst hat, die Mail direkt selbst aus, ohne den Skipper bemühen zu müssen. `resendSettlement` nutzt das gleiche Mail-Template mit `isUpdate=true` (Subject „Bordkasse-Update", Wortlaut „Bilanz aktualisiert" + optionale ChangeSummary aus dem Audit-Log, z. B. „3 neu, 1 geändert"), setzt `trips.last_settlement_resend_at` und löscht den Marker. Spam-Schutz: Resend funktioniert nur bei gesetztem Marker — nach jedem erfolgreichen Versand verschwindet der Banner bis zur nächsten Änderung.
- **Trip-Datum nachträglich ändern:** Skipper/Co-Skipper/Admin können in den Trip-Settings unter „Törn-Datum" Start- und End-Datum korrigieren. Refine prüft `end_date >= start_date`. Bestehende Buchungen werden nicht automatisch verschoben — der Hinweis-Text macht das klar.

## Lokales Setup

```bash
# 1. Dependencies
pnpm install

# 2. Lokale Supabase starten (Postgres + Auth + Studio in Docker)
supabase start
# → liefert URLs + Keys (anon, service_role)

# 3. .env.local einrichten
cp .env.local.example .env.local
# Pflicht-Vars:
#   NEXT_PUBLIC_SUPABASE_URL = http://127.0.0.1:54321
#   NEXT_PUBLIC_SUPABASE_ANON_KEY  (aus `supabase status`)
#   SUPABASE_SERVICE_ROLE_KEY      (aus `supabase status`)
#   ADMIN_EMAILS = deine.email@example.com   (Komma-separiert)
# Für Vercel-Cron-Schutz in Production zusätzlich:
#   CRON_SECRET = <zufälliger Wert>

# 4. Migrations + Seed in lokale DB einspielen
supabase db reset

# 5. Dev-Server
pnpm dev   # http://localhost:3000
```

**Hilfreiche lokale Endpoints:**
- App: <http://localhost:3000>
- Supabase Studio (DB-Inspector): <http://127.0.0.1:54323>
- Mailpit (Magic-Link-Postfach lokal): <http://127.0.0.1:54324>

## Tests

```bash
pnpm test          # Vitest — Berechnungs-Logik (S1–S7) + Schemas
pnpm typecheck     # tsc --noEmit
pnpm lint          # ESLint
pnpm e2e:install   # einmalig — Chromium für Playwright
pnpm e2e           # Playwright Smoke-Tests gegen laufende Dev-App
pnpm build         # Production-Build
```

`pnpm e2e` setzt voraus, dass `pnpm dev` parallel läuft. Tests gegen einen anderen Origin lassen sich mit `E2E_BASE_URL=https://… pnpm e2e` fahren.

DB-Smoke-Test (psql gegen lokale Supabase):
```bash
PATH="/opt/homebrew/opt/libpq/bin:$PATH" \
PGPASSWORD=postgres \
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/_smoke_tests.sql
```

## Ordnerstruktur

```
app/                            Next.js App Router
  /                             Trip-Liste (eigene + Admin-Sicht auf alle)
  /login                        Magic-Link-Form
  /auth/callback                Legacy PKCE-Callback (für ältere Mails)
  /auth/confirm                 Klick-Bestätigungsseite (Token-Hash-Flow)
  /auth/verify                  POST-Endpoint: verifyOtp + Session-Cookies setzen
  /profile                      User-Settings + Admin-Badge
  /datenschutz                  DSGVO-Erklärung
  /trips/new                    Anlege-Wizard (admin-only, optional Skipper-Email)
  /trips/[id]/                  Layout (Header + Bottom-Nav + Realtime)
    page.tsx                    Dashboard + FAB
    transactions/               Liste + /new (Form mit Komma-Eingabe + Idempotency)
    balance/                    Saldo-Tabelle
    debts/                      Vereinfachte Überweisungen + Bezahlt-Häkchen
    stats/                      Live-Statistik (Kategorie + Tag)
    settings/                   Crew (Skipper-Toggle, Edit) + Kategorien (Icon-Picker) + Archiv
  /api/cron/purge               Cron-Endpoint (DSGVO-Löschung), via vercel.json täglich

components/
  bottom-nav.tsx                Bottom-Tabs + FAB
  offline-banner.tsx            Sticky Banner für Offline-Status + Pending-Outbox
  realtime-trip.tsx             Supabase-Realtime-Subscriptions
  service-worker-register.tsx   PWA-SW-Lifecycle + Update-Toast

lib/
  supabase/server.ts            Cookie-Client für Server Components / Auth-Routes
                                (akzeptiert optional NextResponse für Cookie-Binding bei Redirects)
  supabase/admin.ts             Service-Role-Client für Server Actions (RLS-Bypass)
  supabase/read-client.ts       Read-Helper: Admin → Service-Role, sonst Cookie-Client
  auth/get-current-person.ts    Verknüpft Auth-User mit persons-Row, liefert eigene Email aus persons_private
  auth/authz.ts                 requireAuth/Skipper/Admin/SkipperOrAdmin/Member + isEmailAllowedToSignIn
  auth/invite.ts                Magic-Link-Versand beim Crew-Add (frischer anon-Client ohne Cookies)
  actions/                      Server Actions (Trips, Crew, Kategorien, Buchungen, Settled-Debts)
  queries/                      Lese-Pfade über readClient() (Trips, Transaktionen, Bilanz, Stats, Settled-Debts)
  calc/                         TS-Mirror der SQL-Logik (für Vitest, nicht im Render-Pfad)
  validation/                   Zod-Schemas (Komma→Punkt-Preprocess)
  categories/icons.ts           Kuratierte lucide-react-Icon-Whitelist + Name-Match-Fallback
  offline/outbox.ts             IndexedDB-Outbox
  offline/sync.ts               Replay der Outbox bei Reconnect
  db/audit.ts                   Audit-Log-Helper

components/category-icon.tsx    Render-Wrapper für Kategorie-Icons (mit Name-Fallback)
components/icon-picker.tsx      Chip-Grid für Icon-Auswahl im Settings-Tab

supabase/
  config.toml                   Supabase-CLI-Config
  migrations/                   0001 init · 0002 views · 0003 funcs · 0004 RLS
                                · 0005 idempotency · 0006 audit_log
                                · 0007 soft-delete · 0008 co-skippers
                                · 0009 settled_debts · 0010 category_icons (Emoji-Initial)
                                · 0011 data_retention · 0012 category_icons_lucide
                                · 0013 privacy (persons_private)
                                · 0014/0015 per_person + tip · 0016 tip_distribution
                                · 0017 settlement_announce
                                · 0018 purge nur bei bezahlten Schulden + manuell
                                · 0019 settlement_resend (changes_pending_since)
  email-templates/              Branded Magic-Link-Mail (deutsch + Logo)
  seed.sql                      10-Personen-Crew + Test-Törn

__tests__/                      Vitest-Suiten (calc + schema)
e2e/                            Playwright Smoke-Tests
```

## Deploy zu Vercel + Supabase Cloud

Voraussetzungen: Vercel↔GitHub-Verknüpfung, Supabase-Account, SMTP-Provider (z. B. Resend oder eigener Mailserver).

**1. Supabase-Projekt anlegen** (Cloud-Dashboard) und Project URL + `anon` + `service_role` Keys notieren.

**2. Migrations pushen:**
```bash
supabase link --project-ref <ref>
supabase db push
```

**3. Auth konfigurieren** (Supabase Dashboard → Authentication):
- SMTP-Provider eintragen (z.B. Resend mit eigener Sender-Domain)
- **Sign In / Providers → Email:** „Confirm email" auf **OFF** (wir nutzen Magic-Link-Only-Auth; Confirm-Signup würde sonst eine unbranded Vorab-Mail schicken)
- **URL Configuration:** Site URL = Production-Domain, Redirect URLs enthalten `/auth/callback`, `/auth/confirm`, `/auth/verify`
- **Email Templates → Magic Link:** Inhalt aus [`supabase/email-templates/magic-link.html`](supabase/email-templates/magic-link.html) einsetzen. Die URL muss `&type=email&email={{ .Email }}` enthalten (kein `{{ .Type }}` — das rendert bei Magic-Links als leer). Subject z.B. `Dein Bordkasse-Login-Link`.
- Optional: Email OTP Expiration auf 900 s (15 Min) reduzieren (Default: 3600 s)

**4. Vercel-Project anlegen:**
- **Root Directory:** `webapp`
- **Framework:** Next.js (auto-detect)
- **Env-Variables (alle Environments):**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `ADMIN_EMAILS` (Komma-separiert)
  - `CRON_SECRET` (für `/api/cron/purge`-Schutz; zufällig generieren)

**5. Deploy.** Domain auf eigene Subdomain mappen (CNAME → `cname.vercel-dns.com.`).

**6. Cron-Job aktivieren:** Vercel liest `vercel.json` automatisch und richtet den täglichen Purge-Cron ein. Die Route ist via `Authorization: Bearer ${CRON_SECRET}` abgesichert.

### PWA-Updates auf installierten Geräten

Wie die Crew Updates bekommt:

- **Online-Aufruf:** Browser holt HTML mit `NetworkFirst`, neue `_next/static/*.js`-Chunks (Hash-Namen) werden automatisch nachgeladen. Crew sieht beim nächsten Öffnen die aktuelle Version.
- **Service-Worker-Update:** Browser fragt `/sw.js` byte-genau ab (max. alle 24 h). Ändert sich die Datei, installiert er die neue SW-Version und löst über `controllerchange` einen automatischen Page-Reload aus (siehe [`service-worker-register.tsx`](components/service-worker-register.tsx)).
- **Wann muss man `CACHE_VERSION` in [`public/sw.js`](public/sw.js) hochzählen?**
  - Pflicht: bei Änderungen an `sw.js` selbst (neuer Fetch-Handler, andere Cache-Strategie, präcachten Asset-Liste).
  - Empfohlen: nach DB-Schema- oder Auth-Flow-Changes, damit Offline-User mit veraltetem Cache nicht in inkonsistenten Zustand laufen.
  - Optional: bei reinen UI-Änderungen — der HTML-`NetworkFirst`-Pfad zieht neue Chunks ohnehin nach, sobald online.
- **Browser-Update offline ist nicht möglich.** Wenn ein User die PWA seit Wochen offline nutzt, bleibt sie auf dem alten Stand. Erst beim ersten Online-Aufruf rollt die neue Version durch.

## Architektur-Notizen

- **Server Actions + Service-Role:** Auth-Cookie kommt im Next.js 16 Server-Action-Pfad nicht zuverlässig durch RLS. Der Workaround: `getCurrentPerson()` validiert die Session über den Cookie-Client, anschließend schreiben Server Actions mit dem Admin-Client (Service-Role) — RLS wird gezielt umgangen, Authz wandert in App-Layer (`lib/auth/authz.ts`).
- **Read-Pfad mit Admin-Bypass:** alle Lese-Queries laufen über `lib/supabase/read-client.ts:readClient()`. Für `ADMIN_EMAILS`-User liefert es den Service-Role-Client (RLS-Bypass → Admin sieht fremde Törns), für alle anderen den Cookie-Client mit aktivem RLS.
- **Auth-Route Cookie-Binding:** in `/auth/verify` (POST) wird zuerst die `NextResponse.redirect` erzeugt, dann `createClient(response)` aufgerufen — der Cookie-Adapter schreibt Set-Cookies direkt auf die Response. Ohne diesen Pattern landen Session-Cookies bei Redirects nicht im Browser (siehe Supabase Discussion #35615).
- **Berechnungen serverseitig:** Aufteilungs-Logiken stecken als SQL-Views in `0002_views.sql`, der Greedy-Algorithmus als Postgres-Function in `0003_functions.sql`. Der TS-Mirror in `lib/calc/` ist nur Test-Material.
- **Realtime:** `RealtimeTrip` subscribt auf `transactions`, `trip_members` und `settled_debts` des aktuellen Trips → `router.refresh()` bei Änderung.
- **Idempotency:** jede Buchung trägt einen client-seitig generierten `idempotency_key`; UNIQUE-Index auf `(trip_id, idempotency_key)` macht Doppelklicks und Outbox-Replay-Duplikate unmöglich.
- **Persons-Modell + Privacy-Split:** `persons` (öffentlich: `display_name`, `is_alcoholic`, `auth_user_id`) vs `persons_private` (privat: `last_name`, `email` CITEXT). Ghost-Personen haben `auth_user_id = NULL`; beim ersten Magic-Link-Login wird der Auth-User automatisch mit der passenden Ghost-Row verlinkt (Lookup über `persons_private.email`).
- **Link-Scanner-Schutz:** `/auth/confirm` ist bewusst eine Page (zeigt Button), nicht ein Route Handler. Mail-Programme wie Outlook Safe Links crawlen GET-URLs zur Reputation-Prüfung — wenn die Verifizierung direkt im GET passieren würde, wäre der Single-Use-Token verbraucht, bevor der User selbst klickt. Erst das POST-Formular auf `/auth/verify` löst `verifyOtp` aus.
