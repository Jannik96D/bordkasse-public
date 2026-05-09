# Bordkasse Web-App

Next.js 16 + Supabase Web-App-Variante der Bordkasse. Spec: `../docs/web-app-spec.md`. Plan: `~/.claude/plans/dann-machen-wir-eine-moonlit-starlight.md`.

## Features (v0.1)

- Magic-Link-Auth (Supabase + Resend SMTP in Production)
- Trips anlegen, Crew einladen (per Email, Ghost-Personen werden beim ersten
  Login dieser Person automatisch verlinkt)
- Kategorien pro Trip pflegen
- Buchungen erfassen — alle 4 Aufteilungslogiken aus `docs/calculation-rules.md`:
  - Gleichmäßig
  - An Bord
  - Zeitanteilig
  - Individuell (mit Crew-Checkboxes)
- Plus Alkohol-Anteil-Modifikator
- Plus Gutschriften (direkt + "An Alle")
- Live-Bilanz mit Saldo pro Person
- Vereinfachte Schulden via Postgres-`simplify_debts()`-Function (Greedy)
- Realtime-Sync: mehrere Crew-Mitglieder gleichzeitig — Updates sofort sichtbar

## Lokales Setup (einmalig)

```bash
# 1. Dependencies
pnpm install

# 2. Lokale Supabase starten (Postgres + Auth + Studio in Docker)
supabase start
# → liefert URLs + Keys; "anon"/"service_role" notieren

# 3. .env.local einrichten
cp .env.local.example .env.local
# → SUPABASE_URL = http://127.0.0.1:54321
# → ANON_KEY + SERVICE_ROLE_KEY aus `supabase status` einfügen

# 4. Migrations + Seed in lokale DB einspielen
supabase db reset
```

## Pro Session

```bash
pnpm dev                # Next.js auf http://localhost:3000
```

**Hilfreiche lokale Endpoints:**

- App: <http://localhost:3000>
- Supabase Studio (DB-Inspector): <http://127.0.0.1:54323>
- Mailpit (Magic-Link-Postfach lokal): <http://127.0.0.1:54324>

## Tests

```bash
pnpm test               # Vitest, 9/9 Cases gegen S1–S7 aus calculation-rules.md
pnpm typecheck          # tsc --noEmit
pnpm lint               # ESLint
```

Zusätzlich gibt es einen DB-Smoke-Test (psql gegen lokale Supabase):

```bash
PATH="/opt/homebrew/opt/libpq/bin:$PATH" \
PGPASSWORD=postgres \
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/_smoke_tests.sql
```

## Ordnerstruktur

```
app/                  Next.js App Router
  /                   Trip-Liste (eigene + als Mitglied)
  /login              Magic-Link
  /auth/callback      OAuth-Callback
  /profile            User-Settings
  /trips/new          Wizard
  /trips/[id]/        Layout + Bottom-Tab-Bar
    page.tsx          Dashboard + FAB
    transactions/     Liste + /new
    balance/          Saldo-Tabelle
    debts/            Vereinfachte Überweisungen
    settings/         Crew + Kategorien

components/
  bottom-nav.tsx
  realtime-trip.tsx   Subscribed auf transactions + trip_members

lib/
  supabase/           Server- + Browser-Clients (@supabase/ssr)
  auth/               get-current-person (legt persons-Row beim 1. Login an)
  actions/            Server Actions (CRUD)
  queries/            Read-Side (Bilanz, Schulden, Trips, Transaktionen)
  calc/               TS-Mirror der SQL-Logik (für Vitest)
  validation/         Zod-Schemas

supabase/
  config.toml         CLI-Config (project_id = bordkasse)
  migrations/         0001_init · 0002_views · 0003_functions · 0004_rls
  seed.sql            10-Personen-Crew + Test-Törn April 2026

__tests__/calc.test.ts   Vitest-Suite S1–S7 + Edge-Cases
```

## Deploy zu Vercel + Supabase Cloud

Voraussetzung: Vercel↔GitHub schon verknüpft, Supabase-Account vorhanden, Resend-Account für SMTP.

**1. Supabase-Projekt anlegen** (im Dashboard) und folgende Daten notieren:
   - Project URL
   - `anon` (publishable) Key
   - `service_role` (secret) Key
   - Project Ref (aus URL)

**2. Migrations gegen Cloud-DB pushen:**
```bash
supabase link --project-ref <ref>
supabase db push
```

**3. Auth konfigurieren** (Supabase Dashboard → Authentication):
   - SMTP-Provider: **Resend** eintragen (Host `smtp.resend.com`, User `resend`, Pass = Resend-API-Key)
   - URL Configuration:
     - Site URL = `https://<vercel-url>` oder Custom-Domain
     - Redirect URLs = `+ /auth/callback`

**4. Vercel-Project anlegen** (vom GitHub-Repo `Jannik96D/Bordkasse`):
   - **Root Directory: `webapp`**
   - Framework: Next.js (auto-detect)
   - Environment Variables:
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`

**5. Deploy** — wenn alles grün, Magic-Link-Test mit echter E-Mail durchspielen.

**6. Custom-Subdomain** (optional):
   - Im Vercel-Dashboard "Domains" → eigene Subdomain hinzufügen
   - DNS: CNAME-Eintrag bei deinem Domain-Provider auf `cname.vercel-dns.com.`
   - Auth-URLs in Supabase auf neue Domain updaten

## Architektur-Notizen

- **Berechnungen serverseitig:** alle 4 Aufteilungslogiken + Greedy stecken
  als SQL-Views/Functions in `supabase/migrations/0002_views.sql` und
  `0003_functions.sql`. Frontend ruft nur die Views ab. Es existiert ein
  TS-Mirror in `lib/calc/` — der ist nur für Vitest, nicht im Render-Pfad.

- **RLS:** Helper-Funktions `is_trip_member`, `is_trip_skipper`,
  `current_person_id` in `0003_functions.sql`. Policies in `0004_rls.sql`.
  Realtime ist auf `transactions`, `transaction_participants`,
  `trip_members` aktiviert.

- **Persons-Modell:** `persons.auth_user_id` ist NULL für Ghost-Personen
  (vom Skipper eingeladen, aber noch nicht eingeloggt). Beim ersten Login
  einer Person mit passender E-Mail wird der Auth-User automatisch
  verlinkt (`lib/auth/get-current-person.ts`).
