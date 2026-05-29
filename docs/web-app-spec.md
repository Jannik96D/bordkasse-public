# Web-App Spezifikation — Bordkasse 2.0

> **Status: Komplett implementiert + erweitert.** Phasen 1–4 dieser Roadmap sind live. Aktuelle Architektur und Feature-Liste stehen in [`../webapp/README.md`](../webapp/README.md), die Mechanik des Anzahlungs-Moduls (kam nach dieser Spec dazu) in [`prepayments.md`](prepayments.md). Diese Datei bleibt als historische Roadmap erhalten — sie zeigt, womit das Projekt gestartet ist.

Migrations-Roadmap von der Sheets-Lösung zu einer dedizierten Web-App. Nicht zwingend nötig, aber sinnvoll wenn die Sheets-Variante an Grenzen stößt.

## Wann diese Migration sinnvoll ist

Erst wenn mindestens drei der folgenden Punkte zutreffen:
- Mehrere parallele Törns sollen verwaltet werden
- Crew klagt über Multi-User-Konflikte (gleichzeitiges Bearbeiten in Sheets)
- Smartphone-Nutzung ist trotz mobiler Eingabemaske umständlich
- Daten aus früheren Törns werden vermisst (Sheets-Datei pro Törn → keine Historie)
- Wunsch nach Push-Benachrichtigungen, Offline-Eingaben, oder PWA-Installation
- Finanz-Statistiken über mehrere Törns hinweg (z.B. "wie viel zahle ich pro Jahr")

Solange das nicht der Fall ist: Sheets-Lösung beibehalten und iterativ verbessern.

## Tech-Stack-Empfehlung

| Layer | Technologie | Begründung |
|---|---|---|
| Frontend | Next.js 15 (App Router) | SSR, gute Mobile-Performance, PWA-fähig |
| UI | Tailwind CSS + shadcn/ui | Schnelles Bauen, anpassbar, Mobile-first |
| Backend | Supabase (Postgres + Auth + Realtime) | Komplettpaket, Row Level Security, Free Tier ausreichend |
| Auth | Supabase Auth, Magic Link | Niedrige Hürde — Crew klickt Link in E-Mail, kein Passwort |
| Hosting | Vercel | Zero-config Next.js Deploy, Free Tier reicht |
| Icons | Lucide React | Konsistent, breite Auswahl |

## Datenmodell (Postgres)

```sql
-- Crew-Mitglieder über Törns hinweg
CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,         -- für Auth, optional
  is_alcoholic BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ein Törn
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                      -- z.B. "IJsselmeer Mai 2026"
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  ship_name TEXT,
  skipper_id UUID REFERENCES persons(id),  -- der Verwalter
  archived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Wer ist auf welchem Törn dabei (incl. partielle Anwesenheit)
CREATE TABLE trip_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id),
  on_board_from DATE,    -- NULL = ab Törn-Start
  on_board_to DATE,      -- NULL = bis Törn-Ende
  is_alcoholic BOOLEAN,  -- override für diesen Törn
  note TEXT,
  UNIQUE(trip_id, person_id)
);

-- Kategorien (pro Törn anpassbar)
CREATE TABLE trip_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hint TEXT,
  sort_order INT DEFAULT 0
);

-- Transaktionen
CREATE TYPE transaction_type AS ENUM ('expense', 'credit');
CREATE TYPE split_type AS ENUM ('equal', 'on_board', 'time_proportional', 'individual');

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  type transaction_type NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  category_id UUID REFERENCES trip_categories(id),
  amount NUMERIC(10,2) NOT NULL,
  alcohol_amount NUMERIC(10,2) DEFAULT 0,
  
  -- Bei expense:
  paid_by UUID REFERENCES persons(id),
  split_type split_type,
  
  -- Bei credit:
  credit_from UUID REFERENCES persons(id),
  credit_to UUID REFERENCES persons(id),  -- NULL bedeutet "Alle"
  
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES persons(id)
);

-- Bei split_type = 'individual': welche Personen sind dabei
CREATE TABLE transaction_participants (
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id),
  PRIMARY KEY (transaction_id, person_id)
);
```

## Berechnete Views (statt Apps Script)

```sql
-- Aktive Crewmitglieder pro Törn
CREATE VIEW v_trip_members_with_days AS
SELECT
  tm.id,
  tm.trip_id,
  tm.person_id,
  COALESCE(tm.on_board_from, t.start_date) AS effective_from,
  COALESCE(tm.on_board_to, t.end_date) AS effective_to,
  COALESCE(tm.on_board_to, t.end_date) - COALESCE(tm.on_board_from, t.start_date) + 1 AS days_aboard,
  COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE) AS is_alcoholic
FROM trip_members tm
JOIN trips t ON t.id = tm.trip_id
JOIN persons p ON p.id = tm.person_id;

-- Bilanz pro Person/Törn — als Function, weil komplex
CREATE OR REPLACE FUNCTION calculate_balance(p_trip_id UUID)
RETURNS TABLE (
  person_id UUID,
  display_name TEXT,
  paid NUMERIC,
  share NUMERIC,
  credit_given NUMERIC,
  credit_received NUMERIC,
  balance NUMERIC
)
LANGUAGE plpgsql AS $$
BEGIN
  -- Implementierung: für jede Person die 4 Komponenten berechnen
  -- Details siehe docs/calculation-rules.md
  -- ... (TODO: vollständige Implementierung)
END;
$$;
```

## UI-Komponenten

### Hauptscreens

```
/                          → Liste eigener Törns + "Neuer Törn"
/trips/new                 → Wizard: Name, Datum, Crew einladen
/trips/[id]                → Dashboard: aktueller Törn, schneller "+" Button
/trips/[id]/transactions   → Liste aller Transaktionen, filterbar
/trips/[id]/balance        → Bilanz-Tabelle
/trips/[id]/debts          → Vereinfachte Schulden, mit "Erledigt"-Häkchen
/trips/[id]:settings       → Crew-Mitglieder verwalten, Kategorien

/profile                   → eigener Account (Name, Alkohol-Default)
```

### Mobile-Navigation

Bottom-Tab-Bar (nativ-Feeling):
```
[ Übersicht ]  [ + Eingabe ]  [ Bilanz ]
```

Der "+" Button öffnet ein Modal mit der Eingabemaske — vertikal gestapelt, große Touch-Targets, identisch zur aktuellen Sheets-Eingabe.

### Eingabe-Modal-Workflow

```
1. Art wählen: Ausgabe (default) / Gutschrift
   → bei Gutschrift: andere Felder werden ausgetauscht
2. Pflichtfelder zuerst, mit großen Inputs
3. "Erweitert" Toggle für Alkohol-Anteil, individuelle Anwesenheit
4. Submit → Optimistic Update (sofort sichtbar) + Server-Sync
5. Bei Fehler: Inline-Validation, kein Modal-Schließen
```

## Realtime-Synchronisation

Supabase Realtime auf `transactions`-Tabelle:

```typescript
// Im /trips/[id]-Layout
useEffect(() => {
  const channel = supabase
    .channel(`trip:${tripId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'transactions',
      filter: `trip_id=eq.${tripId}`
    }, (payload) => {
      // Cache invalidieren, Bilanz neu rechnen
      queryClient.invalidateQueries(['trip', tripId])
    })
    .subscribe()
  
  return () => { channel.unsubscribe() }
}, [tripId])
```

Mehrere Crewmitglieder sehen Änderungen sofort — wichtig auf langem Törn wenn mehrere parallel Ausgaben eintragen.

## Authentifizierung & Berechtigungen

### Magic Link Flow

```
1. User gibt E-Mail ein
2. Bekommt Link per Mail: "Klicke hier um in Bordkasse einzuloggen"
3. Klick → automatisch eingeloggt, kein Passwort
4. Session bleibt 30 Tage gültig
```

### Row Level Security

```sql
-- Nur eigene Törns + Törns wo man Mitglied ist
CREATE POLICY "trips_visibility" ON trips
  FOR SELECT USING (
    skipper_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = trips.id AND tm.person_id = auth.uid()
    )
  );

-- Nur Skipper kann Törn editieren, alle Mitglieder können Transaktionen erstellen
CREATE POLICY "transactions_insert" ON transactions
  FOR INSERT WITH CHECK (
    trip_id IN (
      SELECT trip_id FROM trip_members WHERE person_id = auth.uid()
    )
  );
```

## PWA-Konfiguration

```json
// public/manifest.json
{
  "name": "Bordkasse",
  "short_name": "Bordkasse",
  "description": "Bordkasse für Segel-Törns",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#FFFFFF",
  "theme_color": "#114884",
  "orientation": "portrait",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Service Worker für Offline-Eingaben:
- Eingaben werden lokal gequeued wenn offline
- Bei Verbindung automatisch synchronisiert
- Konflikt-Resolution: Last-Write-Wins (bei seltenen Konflikten ok)

## Migration der bestehenden Daten

Aus der Sheets-Datei in die neue DB:

1. Manuell Crew anlegen oder via CSV-Import
2. Aktuellen Törn anlegen
3. Aus dem Transaktionen-Tab CSV exportieren
4. CSV-Import-Endpoint (`POST /api/trips/[id]/import-csv`):
   - Parsed Datum, Typ, Beschreibung, Kategorie, Bezahlt von, Betrag, Aufteilung
   - Mappt auf DB-Schema
   - Validiert (z.B. Personen müssen existieren)
   - Inserts in einer Transaction

## Export-Funktion

Für Crewmitglieder die keinen Account wollen:

```
GET /api/trips/[id]/export?format=xlsx
GET /api/trips/[id]/export?format=pdf
```

Server generiert eine Excel/PDF-Datei mit:
- Übersicht aller Transaktionen
- Bilanz-Tabelle
- Schulden-Plan im Segel-Design

Download-Link kann an Crew per WhatsApp/Mail geschickt werden — die haben dann immer einen offline-Beleg.

## Implementierungs-Reihenfolge (MVP-Pfad)

### Phase 1 — Funktionales MVP (1–2 Wochen)
- [ ] Next.js + Supabase Setup
- [ ] Auth (Magic Link)
- [ ] Datenbank-Schema migrieren
- [ ] CRUD für Trips, Persons, Trip-Members
- [ ] Eingabe-Maske als Modal (Mobile-first)
- [ ] Berechnung server-side (Postgres-Function)
- [ ] Bilanz-Anzeige

### Phase 2 — Kern-Features (1–2 Wochen)
- [ ] Schulden-Algorithmus + Sheet
- [ ] Realtime-Sync
- [ ] Categorien-Verwaltung
- [ ] Transaktions-Liste mit Edit/Delete (mit Audit-Trail)

### Phase 3 — Polish (1 Woche)
- [ ] Segel-Design vollständig (Tailwind-Tokens)
- [ ] PWA-Setup
- [ ] Excel/PDF-Export
- [ ] Auswertungs-Dashboard

### Phase 4 — Nice-to-haves
- [ ] Push-Notifications bei Schulden-Erinnerungen
- [ ] Multi-Trip-Statistiken
- [ ] Vorlagen für wiederkehrende Törns
- [ ] Einladungs-Links für Crew

## Was NICHT migriert werden muss

- Print-Dokumente (Logbuch, Meilenbuch, Packliste) — bleiben als separate Print-Templates
- Crewvertrag, Sicherheitseinweisung — sind statische Dokumente, in der App nur als PDF-Download
