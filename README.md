# Bordkasse für Segel-Törns

Tool zur fairen Aufteilung gemeinsamer Kosten auf Segel-Törns mit wechselnden Crews.

Zwei Implementations-Varianten parallel im Repo:

- **Sheets-Lösung** (`assets/sheets-current/`) — Apps Script v11 + xlsx Layout v10. Pragmatisch, kein Login, sofort einsatzbereit auf Google Sheets.
- **Web-App** (`webapp/`) — Next.js + Supabase + Vercel. Crew-fähig, Magic-Link-Auth, Realtime-Sync, Multi-User-tauglich. Status: v0.1.

Welche Variante du nutzt, hängt von der Crew-Größe und dem Komfort-Bedürfnis ab — siehe `CLAUDE.md` für die Trade-offs.

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
cp .env.local.example .env.local   # ANON + SERVICE_ROLE_KEY aus `supabase status`
supabase db reset                   # Migrations + Seed
pnpm dev                            # http://localhost:3000
```

Magic-Link-Mails landen lokal in Mailpit unter http://127.0.0.1:54324.

Vollständige Anleitung + Deploy-Schritte: `webapp/README.md`.

## Struktur

```
.
├── CLAUDE.md                       Hauptbriefing für Claude Code
├── docs/
│   ├── design-system.md            Segel-Design (Marineblau, Touch-Targets, Typografie)
│   ├── calculation-rules.md        Alle Aufteilungslogiken + Test-Szenarien S1–S7
│   ├── apps-script-reference.md    Apps Script v11 Funktions-Mapping + Zellkoordinaten
│   ├── buttons-setup.md            Klickbare Speichern-Buttons in Google Sheets
│   ├── protection-setup.md         Tabellenblätter schützen, Eingabefelder offen
│   └── web-app-spec.md             Spec der Web-App
├── scripts/
│   ├── migrate_v8_to_v9.py         openpyxl-Umbau v8→v9 (Gutschrift-Tab)
│   └── migrate_v9_to_v10.py        openpyxl-Umbau v9→v10 (Checkbox-Spalte D→C)
├── webapp/                         Next.js Web-App — eigene README + Setup
├── .github/workflows/webapp-ci.yml CI für webapp/ (lint + typecheck + test)
└── assets/
    └── sheets-current/             produktive xlsx + Apps Script + alte Versionen
```

## Wichtigste Regeln (siehe `CLAUDE.md`)

1. **Deutsch ist verbindlich** für UI, Domain-Begriffe, User-Texte
2. **Mobile zuerst** — alle UI-Entscheidungen für Smartphone optimieren
3. **Pragmatik vor Perfektion** — Sheets bleibt für kleine Crews die einfachere Lösung
4. **Audit-Trail** — keine Daten löschen, Korrekturen via Gutschrift
5. **Bei strukturellen Änderungen** alle Formel-Referenzen / SQL-Views prüfen
