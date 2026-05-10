# Bordkasse für Segel-Törns

Tool zur fairen Aufteilung gemeinsamer Kosten auf Segel-Törns mit wechselnden Crews.

Zwei Varianten parallel im Repo:

- **Sheets-Lösung** (`assets/sheets-current/`) — Apps Script v11 + xlsx Layout v10. Kein Login, sofort einsetzbar auf Google Sheets. Eingefroren.
- **Web-App** (`webapp/`) — Next.js + Supabase + Vercel. Crew-fähig, Magic-Link-Auth, Realtime-Sync, PWA-Offline, Statistik-Tab, Audit-Log, automatische DSGVO-Löschung 30 Tage nach Törn-Ende.

## Web-App auf einen Blick

- **Auth:** Magic-Link per E-Mail, PKCE-Flow (Single-Use-Tokens, 60 Min TTL).
- **Rollen:** Admin (über `ADMIN_EMAILS`-Env), Skipper, Co-Skipper, Crew-Member. Admin kann Törns für Freunde anlegen ohne selbst Crew zu sein.
- **Aufteilungslogiken:** Gleichmäßig, An Bord, Zeitanteilig, Individuell + Alkohol-Modifikator.
- **Bilanz & Schulden:** Live-View, Greedy-Schulden-Vereinfachung; Bezahlt-Häkchen Crew-weit synchronisiert (nur Schuldner/Gläubiger/Admin dürfen abhaken).
- **Statistik:** Live-Aggregation nach Kategorie + Tag, bleibt nach Törn-Ende anonymisiert erhalten.
- **PWA:** App lässt sich zum Home-Bildschirm hinzufügen, Buchungen können offline erfasst und werden bei Reconnect automatisch synchronisiert.
- **Sicherheit:** RLS auf allen Tabellen, Service-Role-Bypass nur in Server Actions, Security-Header (HSTS/CSP/X-Frame), `noindex`-Meta + `robots.txt` blocken Crawler, Audit-Log für Schreib-Operationen, Soft-Delete für Buchungen.
- **DSGVO:** Personenbezogene Daten werden 30 Tage nach Törn-Ende automatisch gepurged (Vercel-Cron-Job ruft `purge_expired_trip_data()`). Anonymisiertes Statistik-Aggregat bleibt für die Auswertung erhalten.

## Schnellstart

### Sheets-Lösung (kein Setup nötig)

1. `assets/sheets-current/Bordkasse_IJsselmeer2026_v10.xlsx` in Google Sheets hochladen
2. Apps Script-Editor öffnen, Inhalt von `Bordkasse_AppScript_v11.js` einfügen
3. Buttons + Schutz einrichten gemäß `docs/buttons-setup.md` und `docs/protection-setup.md`

### Web-App (lokales Dev-Setup)

```bash
cd webapp
pnpm install
supabase start
cp .env.local.example .env.local   # Werte aus `supabase status` einsetzen
supabase db reset                   # Migrations + Seed einspielen
pnpm dev                            # http://localhost:3000
```

Magic-Link-Mails landen lokal in Mailpit unter http://127.0.0.1:54324.

Tests:
```bash
pnpm test          # Vitest — Berechnungs-Logik (S1–S7) + Schemas
pnpm e2e:install   # einmalig — Chromium für Playwright
pnpm e2e           # Playwright — Smoke-Tests gegen laufende Dev-App
pnpm typecheck
pnpm lint
```

Vollständige Anleitung + Deploy-Schritte: [`webapp/README.md`](webapp/README.md).

## Struktur

```
.
├── CLAUDE.md                       Projekt-Briefing (Working Language, Domain-Begriffe, Regeln)
├── docs/
│   ├── design-system.md            Marineblau-Theme, Touch-Targets, Typografie
│   ├── calculation-rules.md        Aufteilungslogiken + Test-Szenarien S1–S7
│   ├── apps-script-reference.md    Apps Script v11 Funktions-Mapping
│   ├── buttons-setup.md            Speichern-Buttons in Google Sheets
│   ├── protection-setup.md         Sheets-Schutz für Crew-tauglichen Einsatz
│   └── web-app-spec.md             Web-App-Architektur-Spec
├── scripts/                        openpyxl-Migrationen v8→v9, v9→v10
├── webapp/                         Next.js Web-App (siehe webapp/README.md)
└── assets/sheets-current/          produktive xlsx + Apps Script + alte Versionen
```

## Wichtigste Regeln (siehe `CLAUDE.md`)

1. **Deutsch ist verbindlich** für UI, Domain-Begriffe, User-Texte
2. **Mobile zuerst** — alle UI-Entscheidungen für Smartphone optimieren
3. **Pragmatik vor Perfektion** — Sheets bleibt für kleine Test-Setups die einfachere Variante
4. **Audit-Trail** — Schreib-Ops landen im `audit_log`, Buchungen werden soft-gelöscht
5. **Bei strukturellen DB-Änderungen** alle Views/Functions/RLS-Policies mitziehen
