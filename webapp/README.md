# Bordkasse Web-App

Next.js 16 + Supabase Web-App-Variante der Bordkasse. Spec: [`../docs/web-app-spec.md`](../docs/web-app-spec.md).

## Features

- **Auth:** Magic-Link per E-Mail (PKCE-Flow, Single-Use, 60 Min TTL); 30 s nach dem Versand erscheint ein „Mail erneut senden"-Button.
- **Rollen:**
  - **Admin** — über `ADMIN_EMAILS` (Env-Var, Komma-separiert). Darf Törns anlegen + alle Trips verwalten + Crew bearbeiten + löschen.
  - **Skipper** — Original-Anleger eines Törns (`trips.skipper_id`); kann nicht degradiert oder entfernt werden.
  - **Co-Skipper** — `trip_members.is_skipper = TRUE`. Darf alles, was der Skipper darf, außer der Original-Skipper-Slot.
  - **Crew-Member** — `trip_members`-Eintrag. Darf Buchungen erfassen + eigene Schulden abhaken; sieht Bilanz/Schulden/Statistik.
- **Aufteilungslogiken:** Gleichmäßig, An Bord, Zeitanteilig, Individuell + Alkohol-Modifikator (siehe [`docs/calculation-rules.md`](../docs/calculation-rules.md)).
- **Gutschriften:** direkt oder „An Alle" — ausschließlich von Skippern/Admins erfassbar.
- **Bilanz & Schulden:** Live aus SQL-Views (`v_balances`, `v_transaction_shares`); `simplify_debts()` als Greedy-Algorithmus für minimale Überweisungen.
- **Bezahlt-Status der Schulden:** Crew-weit synchronisiert in `settled_debts`; nur Schuldner, Gläubiger oder Admin dürfen das Häkchen toggeln.
- **Statistik:** Live-Aggregation pro Trip nach Kategorie + Tag. Bleibt nach DSGVO-Purge anonymisiert in `trip_statistics` erhalten.
- **PWA:** Service Worker (`public/sw.js`) + IndexedDB-Outbox. Buchungen können offline erfasst werden, werden bei Reconnect automatisch synchronisiert (`lib/offline/sync.ts`). Idempotency-Key auf jeder Buchung verhindert Duplikate.
- **Audit-Log:** jede Schreib-Operation (Trip, Crew, Kategorie, Buchung, Settled-Debt) hinterlässt einen Eintrag in `audit_log`. RLS schränkt Lese-Zugriff auf den Skipper des betroffenen Trips ein.
- **Soft-Delete:** Buchungen werden mit `deleted_at` markiert statt physisch gelöscht. Views/Listen filtern automatisch.
- **DSGVO-Datenlöschung:** 30 Tage nach Törn-Ende läuft `purge_expired_trip_data()` und löscht personenbezogene Daten (`trip_members`, `transactions`, `settled_debts`, `audit_log`, Ghost-`persons`). Anonymisiertes Statistik-Aggregat bleibt erhalten. Cron-Job: `vercel.json` ruft `/api/cron/purge` täglich.
- **Security-Header:** HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP — gesetzt in [`next.config.ts`](next.config.ts).
- **Crawler-Schutz:** `robots.txt` + `<meta name="robots" content="noindex,nofollow">`.

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
  /auth/callback                Code → Session-Exchange (PKCE)
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
  supabase/server.ts            Cookie-Client für Server Components / Auth
  supabase/admin.ts             Service-Role-Client für Server Actions (RLS-Bypass)
  auth/get-current-person.ts    Verknüpft Auth-User mit persons-Row
  auth/authz.ts                 requireAuth/Skipper/Admin/SkipperOrAdmin/Member
  actions/                      Server Actions (Trips, Crew, Kategorien, Buchungen, Settled-Debts)
  queries/                      Lese-Pfade (Trips, Transaktionen, Bilanz, Stats, Settled-Debts)
  calc/                         TS-Mirror der SQL-Logik (für Vitest, nicht im Render-Pfad)
  validation/                   Zod-Schemas (Komma→Punkt-Preprocess)
  categories/icons.ts           Kuratierte Kategorie-Emojis
  offline/outbox.ts             IndexedDB-Outbox
  offline/sync.ts               Replay der Outbox bei Reconnect
  db/audit.ts                   Audit-Log-Helper

supabase/
  config.toml                   Supabase-CLI-Config
  migrations/                   0001 init · 0002 views · 0003 funcs · 0004 RLS
                                · 0005 idempotency · 0006 audit_log
                                · 0007 soft-delete · 0008 co-skippers
                                · 0009 settled_debts · 0010 category_icons
                                · 0011 data_retention
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
- SMTP-Provider eintragen
- URL Configuration: Site URL = Production-Domain, Redirect URLs enthalten `+ /auth/callback`
- Optional: Email-Templates aus [`supabase/email-templates/`](supabase/email-templates/) übernehmen
- Empfohlen: Email OTP Expiration auf 900 s (15 Min) reduzieren

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

## Architektur-Notizen

- **Server Actions + Service-Role:** Auth-Cookie kommt im Next.js 16 Server-Action-Pfad nicht zuverlässig durch RLS. Der Workaround: `getCurrentPerson()` validiert die Session über den Cookie-Client, anschließend lesen/schreiben Server Actions mit dem Admin-Client (Service-Role) — RLS wird gezielt umgangen, Authz wandert in App-Layer (`lib/auth/authz.ts`).
- **Berechnungen serverseitig:** Aufteilungs-Logiken stecken als SQL-Views in `0002_views.sql`, der Greedy-Algorithmus als Postgres-Function in `0003_functions.sql`. Der TS-Mirror in `lib/calc/` ist nur Test-Material.
- **Realtime:** `RealtimeTrip` subscribt auf `transactions`, `trip_members` und `settled_debts` des aktuellen Trips → `router.refresh()` bei Änderung.
- **Idempotency:** jede Buchung trägt einen client-seitig generierten `idempotency_key`; UNIQUE-Index auf `(trip_id, idempotency_key)` macht Doppelklicks und Outbox-Replay-Duplikate unmöglich.
- **Persons-Modell:** `persons.auth_user_id` ist NULL für Ghost-Personen (per Email eingeladen, aber noch nicht eingeloggt). Beim ersten Magic-Link-Login wird der Auth-User automatisch mit der passenden Ghost-Row verlinkt.
