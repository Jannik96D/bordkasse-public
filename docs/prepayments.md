# Anzahlungs-Tranchen — Spec

Modul zur Erfassung, Planung und Nachverfolgung von Anzahlungen, die Crew-Mitglieder lange **vor** dem Törn an den Skipper oder einen anderen Vorstrecker leisten — typischerweise als Beteiligung an der Yacht-Charter, die der Skipper bereits Monate vor Reisebeginn buchen und (in Tranchen) bezahlen muss.

> **Status: Implementiert** über Migrationen 0023–0028. Phase 1 (Kern) + Phase 2 (Crew-Selbstmeldung) + Auto-Reminder-Cron + Vorstrecker-Konzept + Charter-Reminder-Mail sind live. Diese Spec spiegelt den aktuellen Stand und beschreibt die Mechanik im Detail.

## Problem

Ein realer Fall: Skipper bucht die Yacht 10 Monate vor dem Törn und streckt die Anzahlung vor. Crew-Mitglieder sagen zu und überweisen ihre Beteiligung **in unterschiedlichem Tempo** — manche sofort, manche erst kurz vor Törn-Start, manche gar nicht. Zwischendurch fällt Person A ab, Person B rückt nach; B übernimmt die Anzahlung, die A bereits geleistet hatte.

Das aktuelle Modell (Buchung + Gutschrift + Bilanz) bildet das Geldfluss-Modell zwar mathematisch korrekt ab, lässt aber drei Lücken:

1. **Soll-Beträge** sind unsichtbar — die App weiß nicht, was eine Person eigentlich zahlen sollte, sondern nur, was sie bezahlt hat.
2. **Mehrere zeitliche Tranchen** (z.B. 30 % bei Buchung, 70 % drei Monate vor Törn) sind nicht modelliert.
3. **Individuelle Beträge** (Stockkoje günstiger, Einzelkoje teurer) lassen sich zwar mit Aufteilung „Pro Person" abbilden, aber nicht **vor** der eigentlichen Yacht-Buchung planen.

## Begriffe

| Begriff | Definition |
|---|---|
| **Anzahlungs-Plan** | Pro Trip eine Konfiguration: Aufteilungs-Methode + Kojen-Definition + Tranchen-Liste |
| **Tranche** | Ein Zahlungstermin mit Fälligkeitsdatum, Label und Prozent-Anteil am Gesamt-Soll |
| **Soll-Betrag (Obligation)** | Was eine Person für eine Tranche zahlen muss — abgeleitet aus Aufteilungs-Methode |
| **Eingang** | Eine Gutschrift „Von Crew → An Skipper" mit Tranche-Zuordnung |
| **Anzahlungs-Pool** | Buchungen + Gutschriften mit `tranche_id ≠ NULL` — getrennt von der laufenden Bordkasse |
| **Bordkasse-Pool** | Alle Buchungen ohne Tranche-Zuordnung (= während des Törns angefallene Kosten) |
| **Kojen-Modell** | Spezialfall der Soll-Berechnung: Crew wird Kojentypen mit individuellen Preisen zugeordnet |

## Datenmodell

```sql
-- Konfiguration pro Trip
prepayment_plan
  trip_id            UUID PK REFERENCES trips(id) ON DELETE CASCADE
  split_method       TEXT CHECK (split_method IN ('gleichmaessig','zeitanteilig','individuell','kojen'))
  total_amount       NUMERIC(10,2)  -- Gesamt-Anzahlungssumme (z.B. Yacht-Charter-Preis)
  advancer_person_id UUID NULL REFERENCES persons(id) ON DELETE SET NULL
                                    -- Wer streckt vor? NULL = Trip-Skipper als Fallback. (Migration 0024)
  wero_id            TEXT           -- Wero-ID des Vorstreckers (Mobil/E-Mail), optional pro Trip
  whatsapp_template  TEXT           -- Editierbare Vorlage mit Platzhaltern

-- Nur wenn split_method = 'kojen': Kojen-Typen mit Preis pro Person
cabin_types
  id             UUID PK
  trip_id        UUID REFERENCES trips(id) ON DELETE CASCADE
  label          TEXT  -- 'Einzelkoje' | 'Doppelkoje' | 'Stockkoje' | frei
  price_per_person NUMERIC(10,2)
  capacity       INT   -- max. Anzahl Personen, die dieser Koje zugeordnet werden dürfen
  sort_order     INT

-- Pro Person das aktuelle Gesamt-Soll + ggf. Kojen-Zuordnung
prepayment_obligations
  trip_id        UUID
  person_id      UUID
  cabin_type_id  UUID NULL REFERENCES cabin_types(id) ON DELETE SET NULL
  total_amount   NUMERIC(10,2)  -- finales Gesamt-Soll der Person über alle Tranchen
  PRIMARY KEY (trip_id, person_id)

-- Zeitliche Aufteilung
prepayment_tranches
  id                UUID PK
  trip_id           UUID REFERENCES trips(id) ON DELETE CASCADE
  due_date          DATE          -- Charter-Frist gegenüber der Agentur (Crew-Frist = due_date − 3 Tage)
  label             TEXT          -- z.B. '1. Anzahlung', 'Endzahlung'
  percent           NUMERIC(5,2)  -- 0..100, Summe aller Tranchen eines Trips = 100
  wero_request_link TEXT NULL     -- DEPRECATED: aus UI entfernt (Wero hat keine offene API).
                                  -- Spalte bleibt aus Schema-Stabilität, ist immer NULL/leer.
  sort_order        INT

-- Bestehende transactions-Tabelle bekommt eine Spalte:
transactions
  + tranche_id   UUID NULL REFERENCES prepayment_tranches(id) ON DELETE SET NULL
  + confirmed_at TIMESTAMPTZ NULL DEFAULT now()  -- Migration 0025: NULL = pending Selbstmeldung

-- Auto-Reminder-Dedup (Migration 0028)
prepayment_reminder_log
  id            UUID PK DEFAULT gen_random_uuid()
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE
  tranche_id    UUID NOT NULL REFERENCES prepayment_tranches(id) ON DELETE CASCADE
  person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('crew_3d', 'advancer_3d'))
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  UNIQUE (tranche_id, person_id, reminder_type)
```

**Anmerkungen:**
- `prepayment_obligations.total_amount` ist das **Gesamt-Soll der Person**. Pro-Tranche-Soll wird im Render-Pfad berechnet als `total_amount × tranche.percent / 100`.
- `transactions.tranche_id` markiert sowohl Skipper→Charter-Ausgaben („Yacht 1. Anzahlung") als auch Crew→Skipper-Gutschriften als zum Anzahlungs-Pool gehörig.
- Beim Löschen einer Tranche werden zugehörige Transaktionen **nicht** gelöscht — `tranche_id` wird auf `NULL` gesetzt, die Buchung wandert in den Bordkasse-Pool. UI muss vor Tranche-Löschung warnen.

## Aufteilungs-Methoden (Schritt 1 im Wizard)

### 1. Gleichmäßig
`total_amount` wird gleich auf alle Crew-Mitglieder verteilt.

### 2. Zeitanteilig
Verteilung nach Bord-Tagen (siehe `calculation-rules.md` → „Zeitanteilig").

### 3. Individuell
Skipper tippt pro Person einen Betrag.

### 4. Nach Kojen
- Skipper definiert Kojen-Typen mit **Preis pro Person**:
  ```
  Einzelkoje:  1 × 1.200 € pro Person   (Kapazität: 1)
  Doppelkoje:  2 × 800 € pro Person     (Kapazität: 2)
  Stockkoje:   1 × 500 € pro Person     (Kapazität: 2)
  ```
- Jede Crew bekommt per Dropdown eine `cabin_type_id` zugeordnet.
- Kapazität wird beim Speichern validiert: max. `Σ capacity` Plätze.
- Soll = `cabin_type.price_per_person`.
- Bei „Pro Person"-Eingabe gilt: der Preis wird so eingetippt, wie ihn der Charterer angibt — z.B. „Doppelkoje 800 € pro Person" heißt: beide Bewohner zahlen je 800 €. Doppel-belegt = doppelter Erlös für den Charterer.

## Tranchen (Schritt 2 im Wizard)

Skipper definiert eine Liste von Tranchen mit `due_date`, `label`, `percent`. Validierung: `Σ percent = 100` (Toleranz ±0,01). Beispiel:

```
Tranche 1: "Reservierungs-Anzahlung" — fällig 15.07.2026 — 30 %
Tranche 2: "Endzahlung"               — fällig 01.01.2027 — 70 %
```

Tranchen-Aufteilung gilt **einheitlich für alle Crew** — keine pro-Person-Overrides. Wenn eine Person eine Tranche überzahlt, kann das Modal (siehe „Spezialfälle") den Überschuss auf eine andere Tranche umbuchen.

## Eingangs-Erfassung (Crew → Skipper)

Drei Eingangspunkte; in Phase 1 nur Weg 1 + 2, Weg 3 folgt in Phase 2.

### Weg 1 — Aus der Anzahlungs-Matrix (primär)

Anzahlungs-Übersicht zeigt die Soll-Matrix Crew × Tranche mit Status-Symbolen:

```
                Tranche 1 (15.07.)            Tranche 2 (01.01.27)
Anna           ⚠️ 240 € offen   ← Klick       ⚠️ 560 € offen
Ben            ◐ 100/240 € am 18.07.          ⚠️ 560 € offen
Clara          ✅ 240 € am 12.07.             ⚠️ 560 € offen
```

Klick auf eine offene/teilweise Zelle öffnet ein Modal:

```
┌─ Zahlung von Anna erfassen ──────────┐
│ Tranche 1 — Reservierungs-Anzahlung  │
│ Soll:    240 €                       │
│ Bezahlt:   0 €                       │
│ Offen:   240 €                       │
│                                      │
│ Betrag       [240,00 €     ]         │
│ Datum        [heute        ]         │
│ Notiz        [via Wero     ] opt.    │
│                                      │
│       [Abbrechen]   [Speichern]      │
└──────────────────────────────────────┘
```

Speichern → erzeugt im Backend eine reguläre Gutschrift:
- `credit_from = anna.person_id`
- `credit_to = skipper.person_id`
- `tranche_id = tranche1.id`
- `amount`, `date`, `note` aus Modal
- Reguläre Audit-Log-Spur + Idempotency-Key

Status der Zelle aktualisiert sich aus `Σ Gutschriften mit dieser tranche_id` vs. `Soll`.

### Weg 2 — Über die normale Gutschrift-Maske

Bestehende „Neue Gutschrift"-Maske bekommt ein zusätzliches Dropdown **„Anzahlungs-Tranche zuordnen"**:
- Default: `— Keine —` (= Bordkasse-Pool)
- Sonst: Auswahl einer Tranche des Trips → landet im Anzahlungs-Pool

### Weg 3 — Crew-Selbstmeldung (Phase 2, implementiert)

Crew-Mitglied sieht in seiner Trip-Sicht (CrewSelfView) den eigenen Tranchen-Status + Button **„Ich habe gezahlt"**:
- Klick → erzeugt eine reguläre Gutschrift mit `confirmed_at = NULL` (= pending). Der Empfänger ist der **Vorstrecker** des Trips, nicht zwingend der Skipper.
- Vorstrecker bekommt Mail (`payment-pending-template.ts`) + Hinweis in der Matrix (Symbol ⏳, Pending-Banner mit ✓/✗-Buttons)
- Vorstrecker bestätigt mit ✓ → `confirmed_at = now()`, Eintrag zählt ab sofort in `v_prepayment_payments`
- Bei Ablehnung mit ✗ → Soft-Delete via `deleted_at`. Crew-Mitglied bekommt eine Notice-Mail mit Hinweis „sprich mit dem Vorstrecker, falls das ein Versehen war" (kein freier Antwort-Text, um Streit zu vermeiden — Klärung per WhatsApp)

**Datenmodell:** `transactions.confirmed_at TIMESTAMPTZ NULL DEFAULT now()` aus Migration 0025. Normale Skipper-/Admin-/Vorstrecker-Eingaben sind dadurch sofort bestätigt, nur `submitSelfPayment` schreibt explizit `NULL`. View `v_prepayment_pending` aus derselben Migration listet alle offenen Selbstmeldungen.

## Status-Symbole

In der Matrix als gerahmte Checkbox-Boxen gerendert (vgl. Schulden-Seite), Status-Glyphe als `aria-hidden`-Span darin:

| Glyphe | Bedeutung | Bedingung |
|--------|-----------|-----------|
| ○ (leere Box) | Offen | keine Zahlung erfasst |
| ◐ | Teilweise | 0 < Σ Zahlungen < Soll |
| ✓ (grüner Haken) | Bezahlt | Σ Zahlungen ≥ Soll |
| ⏰ + roter Rahmen | Überfällig | `due_date < heute` UND Status ∈ {offen, teilweise} |
| ⏳ + gelber Rahmen | Gemeldet, unbestätigt | Selbstmeldung mit `confirmed_at = NULL` |

## Bilanz-Ansicht (drei Blöcke)

```
┌─ Anzahlungen ───────────────────────┐
│ Soll:        1.000 €                │
│ Bezahlt:       500 €                │
│ Offen:         500 €                │
│ Status:      ⏰ Tranche 2 überfällig │
├─ Bordkasse (während Törn) ──────────┤
│ Saldo:         -42 €                │
├─ Gesamt ────────────────────────────┤
│ Saldo:        +458 €                │
└─────────────────────────────────────┘
```

**Berechnungs-Pfad:**
- Anzahlungs-Soll = `prepayment_obligations.total_amount` der Person
- Anzahlungs-Ist = `Σ transactions` der Person mit `tranche_id ≠ NULL`
- Bordkasse-Saldo = `v_balances` (existierende View), gefiltert auf `tranche_id IS NULL`
- Gesamt-Saldo = Anzahlungs-(Ist - Soll) + Bordkasse-Saldo

**Wichtig:** die existierende `v_balances`-View muss erweitert werden, um den `tranche_id`-Filter zu kennen — oder es entsteht eine zweite View `v_prepayment_balances`.

## Yacht-Buchung des Skippers (Skipper → Charter)

Die echte Yacht-Buchung (Skipper überweist 5.000 € an die Charteragentur) wird über die **normale Buchungs-Maske** erfasst, ergänzt um ein neues Feld **„Anzahlungs-Tranche zuordnen"**:

```
Beschreibung:  [1. Anzahlung Yacht — Charter Werner   ]
Kategorie:     [Yacht ▾]
Bezahlt von:   [Skipper ▾]
Betrag:        [5.000,00 €]
Aufteilung:    [Nach Kojen ▾]   ← liest cabin_types
Tranche:       [Tranche 1 ▾]    ← neu
Datum:         [12.07.2026]
```

Sobald die Tranche zugeordnet ist:
- Buchung landet im **Anzahlungs-Pool** (taucht nicht im Bordkasse-Saldo auf)
- Aufteilung „Nach Kojen" zieht die Kojen-Preise automatisch aus dem `prepayment_plan` → keine doppelte Eingabe

**Reihenfolge ist egal:** der Skipper kann die Charter-Anzahlung erst überweisen und dann die Crew-Eingänge erfassen, oder umgekehrt. Der Anzahlungs-Pool-Saldo zeigt zu jedem Zeitpunkt den korrekten Stand.

## Restausgleich Tranchen-Soll ≠ finale Yacht-Buchung

Wenn die Summe der Tranchen-Soll-Beträge nicht exakt mit den finalen Yacht-Buchungen übereinstimmt (z.B. Skipper bekommt 5 % Rabatt, oder es kommt ein Hafen-Aufschlag dazu), wird die Differenz **automatisch über die Bordkasse-Bilanz verrechnet**. Keine Warnung, kein extra Workflow.

Mathematisch: das Anzahlungs-Pool-Saldo ist nicht-Null und fließt in den Gesamt-Saldo ein → Settlement-Algorithmus löst das mit auf.

## Spezialfälle

### Teilzahlung
Modal-Betrag-Feld editierbar, Default = aktueller Restbetrag der Tranche. Nach Speichern: Status ◐, beim nächsten Klick = neuer Restbetrag als Default.

### Überzahlung
Vor Speichern Warnhinweis:
```
60 € mehr als Tranche-1-Soll. Was tun?
  ( ) 60 € auf Tranche 2 anrechnen
  ( ) Als Guthaben in Tranche 1 stehen lassen
```

Variante 1 erzeugt **zwei** Gutschriften (240 € auf Tranche 1, 60 € auf Tranche 2) statt einer 300-€-Gutschrift. Audit bleibt sauber.

### Mehrere Zahlungen für eine Tranche
Jede Zahlung wird als eigene Gutschrift gespeichert. Matrix aggregiert; Detail-Ansicht der Zelle zeigt alle Einzel-Zahlungen mit Datum + Notiz.

### Korrektur / Storno
Klick auf ✅-Zelle → Detail-Modal mit Liste aller Gutschriften → ✏️ Edit oder 🗑️ Delete über bestehenden Buchungs-Edit-Flow (Skipper/Admin/Ersteller dürfen).

### Falsche Tranche zugeordnet
Edit der Gutschrift → Tranche-Dropdown ändern → Matrix-Status aktualisiert sich beidseitig.

### Crew-Mitglied ohne E-Mail-Adresse
Skipper darf Crew anlegen, ohne E-Mail-Adresse zu kennen:
- `inviteMember`-Schema in `lib/actions/trip-members.ts:14` muss von `.email(...)` auf `.email(...).optional().or(z.literal(""))` umgestellt werden
- Logik verzweigt: mit E-Mail → wie heute inkl. Auto-Invite-Mail; ohne E-Mail → nur `persons.display_name`, `persons_private` bleibt leer
- Crew kann **trotzdem**: Koje zugewiesen bekommen, Soll-Beträge erhalten, Zahlungen via Weg 1 erfasst werden, in Buchungen verwendet werden, WhatsApp-Text generiert werden
- Crew kann **nicht**: sich einloggen, Erinnerungsmail empfangen, Phase-2-Selbstmeldung nutzen
- Sobald E-Mail nachgetragen wird (Inline-Edit): Auto-Invite-Mail wird **dann** ausgelöst (wie heute beim Anlegen)
- UI-Indikator: blasses Warn-Symbol neben Crew-Namen in der Liste, solange E-Mail fehlt

## Crew-Wechsel-Workflow

Action **„Crew-Mitglied ersetzen"** in der Crew-Verwaltung. Annahme aus Iteration: „Ersatz übernimmt Anzahlung direkt" — d.h. B hat A privat ausbezahlt.

Schritte:
1. Skipper wählt A → klickt „Ersetzen" → Modal fragt nach Daten von B (Name + E-Mail optional).
2. B wird als neues Crew-Mitglied angelegt (ggf. ohne E-Mail).
3. A's `prepayment_obligations`-Zeile wird auf B übertragen (`person_id` umgeschrieben, `cabin_type_id` bleibt).
4. A's bisher gezahlte Gutschriften werden umgebucht: pro Gutschrift wird eine **kompensierende Gutschrift** erzeugt:
   - „Von B → An A" in Höhe der gezahlten Summe (= B hat A ausbezahlt, jetzt steht B in der App in A's ursprünglicher Position)
   - Buchhalterisch landet B in der Bilanz dort, wo A war; A geht auf 0 €
5. A wird auf `on_board_from = NULL, on_board_to = NULL` gesetzt (= „nicht mehr dabei"), aber **nicht gelöscht** — wegen Audit-Spur der ursprünglichen Anzahlung.
6. Audit-Log-Eintrag „Crew-Wechsel A → B am Datum X, Anzahlung übertragen: Y €".

**Edge Case Crew-Wechsel zwischen Tranchen:** A hat Tranche 1 voll bezahlt, ist vor Tranche 2 abgesprungen. B übernimmt → bekommt Tranche-1-Status „bezahlt" geerbt, Tranche-2-Soll auf B.

## Mail-Templates + WhatsApp-Texte

WhatsApp-Versand läuft immer manuell. Mail-Versand läuft entweder manuell (🔔-Button) oder automatisch via Cron (siehe „Implementierte Erweiterungen" → Auto-Reminder).

Alle Mails nutzen [`lib/email/mail-shell.ts`](../webapp/lib/email/mail-shell.ts) — gemeinsamer Logo-PNG-Header + Card + Footer.

### Erinnerungsmail an Crew (`prepayment-reminder-template.ts`)

Pro Person-Zeile in der Matrix ein Knopf 🔔, plus Auto-Versand vom Cron innerhalb der letzten 3 Tage vor Crew-Fälligkeit. Crew mit pending Selbstmeldung wird automatisch übersprungen. Inhalt:
- Anrede mit Display-Name
- Liste der offenen Tranchen mit Soll-Betrag und Crew-Fälligkeitsdatum (= Charter-Frist minus 3 Tage)
- Dynamischer Wero-Hinweis: „Bitte schicke **{Vorstrecker}** per Wero die fällige Anzahlung." mit Wero-ID + Verwendungszweck als Pille. **Kein Klick-Link** — Wero hat keine offene API. Falls keine Wero-ID gepflegt: „Frag {Vorstrecker} nach den Überweisungsdetails."
- Hint-Block am Mail-Ende erklärt die Wero-Limitation
- Link zur Bordkasse (`/trips/{id}/prepayments`)

Voraussetzung: Crew-Mitglied hat E-Mail-Adresse. Sonst ist der 🔔-Button deaktiviert mit Tooltip „E-Mail fehlt".

### Charter-Reminder-Mail an den Vorstrecker (`charter-reminder-template.ts`)

In der Matrix-Zeile des Vorstreckers schickt der 🔔-Button **nicht** seine persönlichen Tranchen, sondern eine Charter-Übersicht pro Tranche:
- Soll Agentur (Tranchen-Prozent × `total_amount`)
- Σ Crew-Eingänge bei dir vs. Σ Crew-Soll
- Schon an Agentur überwiesen (Σ expense-Buchungen mit dieser Tranche)
- Noch zu überweisen

Wird auch automatisch vom Cron innerhalb der letzten 3 Tage vor Charter-Fälligkeit verschickt — aber nur wenn der Vorstrecker der Agentur noch was schuldet (`remaining_to_agency > 0`). „Crew bei dir" und „Σ Crew-Soll" klammern den Vorstrecker selbst aus, sein treuhänderischer Eigen-Anteil fließt nicht in diese Zahlen ein. In der Matrix ist die Vorstrecker-Glocke disabled, wenn nichts mehr offen ist. Routing-Logik: `personId === advancer_person_id` → Charter-Pfad; sonst Crew-Pfad.

### Selbstmeldungs-Benachrichtigung (`payment-pending-template.ts`)

Geht an den Vorstrecker, wenn ein Crew-Mitglied „Ich habe gezahlt" geklickt hat. Enthält Tranche-Label, Crew-Fälligkeit, Betrag, optionale Notiz, Direktlink zur Matrix zum Bestätigen.

### Notice-Mails bei Admin-Aktionen (`prepayment-notice-template.ts`)

Generisches Template mit drei Varianten:
- `payment_recorded` → wenn jemand für eine andere Person eine Zahlung erfasst hat
- `payment_confirmed` → wenn jemand eine Selbstmeldung bestätigt hat (Empfänger: Vorstrecker, falls Actor ≠ Vorstrecker)
- `payment_rejected` → wenn jemand eine Selbstmeldung abgelehnt hat (Empfänger: Crew-Person + Vorstrecker, falls Actor ≠ beide)

Self-Aktionen (Crew meldet selbst, Vorstrecker bestätigt selbst) erzeugen keine Notice-Mail.

Bei Overzahlung mit Overflow-Split in `recordPayment` (part1 auf gewählte Tranche, part2 auf overflow_tranche_id) geht **pro gebuchter Tranche eine eigene Notice-Mail** mit dem jeweiligen Teilbetrag raus — nicht eine Mail mit Gesamtbetrag auf der ersten Tranche.

### Observer-Mail bei Bordkasse-Schulden (`debt-observer-template.ts`)

Wenn eine **dritte Person** (Admin) eine Schuld zwischen zwei Crew-Mitgliedern abhakt, bekommen Skipper und Vorstrecker (sofern sie nicht ohnehin Schuldner/Gläubiger sind) eine neutrale Info-Mail mit dem Wortlaut „Schuld zwischen A und B abgehakt" — nicht die normale debt-settled-Mail, die sie sonst irreführend als Gläubiger/Schuldner adressieren würde. Eigenes Template über `mail-shell.ts`, eigene `"observer"`-Rolle im recipients-Array.

### WhatsApp-Text — pro Person

Pro Person-Zeile zusätzlich ein Knopf 💬. Öffnet Modal mit kopierbarem Text basierend auf editierbarer Trip-Vorlage `prepayment_plan.whatsapp_template`. Default-Vorlage:

```
Hi {{name}}, kurze Erinnerung an die {{tranche_label}}
für unseren Törn {{trip_name}}:

  Betrag: {{amount}} €
  Fällig: {{due_date}}
  Wero:   {{wero_link_or_id}}
  Verwendungszweck: Anzahlung {{trip_name}} {{tranche_label}}

Danke! 🙏 ⛵
```

Platzhalter werden zur Render-Zeit ersetzt. Modal hat „In Zwischenablage kopieren"-Button + Hinweis „Jetzt in WhatsApp einfügen".

### WhatsApp-Text — Sammel

Über der Matrix ein Button **„Sammel-Text für alle Offenen erzeugen"**. Öffnet Modal mit einem Block pro Person mit offenem/teilweisem Status — als ein zusammenhängender Text, den der Skipper in eine WhatsApp-Gruppe einfügen kann. Personen ohne offene Posten werden ausgelassen.

## Wero-Integration

- **Profil-Feld:** `prepayment_plan.wero_id` pro Trip (Mobilnummer oder E-Mail des Vorstrecker-Wero-Accounts, **nicht zwingend Skipper**). Wird im Wizard eingegeben.
- **Tranche-Feld:** `prepayment_tranches.wero_request_link` — Spalte existiert noch im Schema, ist aber aus der UI entfernt (Wero-Link-Eingabe im Wizard fehlt, In-App- und Mail-Buttons rendern keinen Link mehr). Hintergrund: Wero hat **keine öffentliche API** für Klick-Links, die wir zuverlässig generieren könnten; vom Nutzer eingegebene Links funktionieren in der Praxis nicht.
- **Crew-Sicht:** statt eines Klick-Buttons zeigt die App eine Wero-Pille mit Wero-ID + Verwendungszweck — die Crew kopiert das manuell in ihre Wero-App.
- **Mail-Hinweis dynamisch:** „Bitte schicke **{Vorstrecker}** per Wero die fällige Anzahlung." Wero-ID + Verwendungszweck als Pille. Bei fehlender Wero-ID: „Frag {Vorstrecker} nach den Überweisungsdetails."
- **Kein IBAN-Fallback:** explizite Entscheidung. Crew ohne Wero muss sich beim Vorstrecker melden.

## Sichtbarkeit

| Rolle | Sicht |
|---|---|
| Skipper / Co-Skipper / Admin / **Vorstrecker** | Komplette Matrix, alle Aktionen (`requireSkipperAdminOrAdvancer`) |
| Crew-Mitglied (eingeloggt, kein Manage-Recht) | CrewSelfView: nur eigene Zeile mit eigenen Tranchen + „Ich habe gezahlt"-Button |
| Ghost-Crew (kein Login) | Keine — nutzt nur die vom Skipper ausgelösten WhatsApp-Texte |

RLS-Policy auf `prepayment_obligations`: Self-Read für eigene `person_id`, Skipper-Read für gesamten Trip (analog zu `persons_private`). Vorstrecker-Aktionen laufen über App-Layer-Authz (`lib/auth/authz.ts:requireSkipperAdminOrAdvancer`), Schreib-Pfad nutzt ohnehin den Service-Role-Client.

## Implementierte Erweiterungen (Stand heute)

Diese Punkte sind über die ursprüngliche Phase-1/Phase-2-Aufteilung hinaus dazugekommen:

- **Vorstrecker-Konzept** (Migration 0024): `prepayment_plan.advancer_person_id` — wer streckt die Charter-Anzahlung tatsächlich vor (Default = Skipper, im Wizard editierbar). Alle Crew-Anzahlungen werden gegen diese Person verbucht. `tx_credit_self` relaxiert für tranche-getaggte Buchungen, damit der Vorstrecker seinen eigenen Anteil als Selbst-Verrechnung abhaken kann.
- **Crew-Fälligkeit 3 Tage vor Charter** (`lib/prepayments/dates.ts:toCrewDueDate`): die Charter-Frist ist verbindlich gegenüber der Agentur — die Crew soll 3 Tage vorher gezahlt haben, damit der Vorstrecker rechtzeitig überweisen kann. Wird konsistent in Matrix-Header, Crew-Self-View, WhatsApp-Vorlage und Mails angewandt; der Charter-Reminder-Banner zeigt weiter das Originaldatum.
- **Bordkasse vs. Anzahlungs-Pool getrennt** (Migrationen 0026 + 0027): `v_balances_bordkasse_only` und `simplify_debts_bordkasse_only` filtern auf `tranche_id IS NULL`. Die untere Bilanz-Tabelle zeigt bei aktivem Plan nur den Bordkasse-Saldo; der Anzahlungs-Pool steht oben als Drei-Block-Übersicht.
- **Charter-Reminder-Mail an den Vorstrecker** ([`lib/email/charter-reminder-template.ts`](../webapp/lib/email/charter-reminder-template.ts)): pro Tranche Soll Agentur, Σ Crew-Eingänge bei mir, schon-überwiesen, noch offen. Wird ausgelöst entweder vom 🔔-Button in der Vorstrecker-Zeile oder automatisch vom Cron 3 Tage vor Charter-Frist. `lib/email/send-prepayment-reminder.ts` routet zwischen Crew-Pfad und Vorstrecker-Pfad anhand von `personId === advancer_person_id`.
- **Auto-Reminder-Cron** (`/api/cron/prepayment-reminders`, täglich `0 7 * * *` in `vercel.json`, Dedup über `prepayment_reminder_log` aus Migration 0028): `crew_3d` = innerhalb der letzten 6 Tage vor Charter-Frist an offene Crew-Mitglieder (= 3 Tage vor Crew-Frist); `advancer_3d` = innerhalb der letzten 3 Tage vor Charter-Frist an den Vorstrecker (Charter-Übersicht). Fenster statt exakter Tagesgleichheit, damit ein verpasster Cron-Tag (Outage, Deploy) keinen Reminder verliert. Pro `(tranche_id, person_id, reminder_type)` höchstens ein Eintrag. **Pending-Awareness:** Crew mit unbestätigter Selbstmeldung (`v_prepayment_pending`) wird übersprungen — sie wartet auf den Vorstrecker. **Advancer-Skip:** keine `advancer_3d`-Mail wenn die Tranche bereits voll an die Agentur überwiesen ist. **Reject räumt Dedup-Log:** `rejectSelfPayment` löscht den `crew_3d`-Eintrag der betroffenen Person, sodass eine korrigierte Mahnung folgen kann. Abgelaufene Trips übersprungen.
- **Notice-Mails bei Admin-Aktionen** ([`lib/email/prepayment-notice-template.ts`](../webapp/lib/email/prepayment-notice-template.ts)): wenn `recordPayment` / `confirmSelfPayment` / `rejectSelfPayment` von einer dritten Person (Admin/Co-Skipper) ausgelöst wird, gehen Info-Mails an Crew-Person + Vorstrecker (sofern Actor ≠ Empfänger). Self-Aktionen erzeugen keine Notice. Pendant für Bordkasse-Schulden: bei Admin-Drittaktion bekommen Skipper und Vorstrecker zusätzliche Observer-Mails.
- **Einheitliches Mail-Design** ([`lib/email/mail-shell.ts`](../webapp/lib/email/mail-shell.ts)): Logo-PNG-Header + Card-Wrapper + Footer als gemeinsame Shell. Alle sechs Templates (settlement, debt-settled, prepayment-reminder, charter-reminder, payment-pending, prepayment-notice) nutzen sie.

## Phasen-Plan (historisch)

Beide Phasen sind abgeschlossen — die Liste bleibt als Referenz drin, falls jemand den ursprünglichen Schnitt nachvollziehen will.

### Phase 1 — Kern (Migrationen 0023 + 0024) — erledigt
- DB-Migration (4 Tabellen + `transactions.tranche_id` + `advancer_person_id`)
- Skipper-Wizard zwei Schritte (Aufteilung + Tranchen, inkl. Kojen-Editor + CrewQuickAdd)
- Anzahlungs-Matrix mit Status-Symbolen + Weg-1-Modal
- Erweiterung der Gutschrift-Maske (Weg 2) und Buchungs-Maske um Tranche-Dropdown
- Bilanz-Erweiterung (drei Blöcke) + Bordkasse-Pool-Trennung
- Crew-Sicht (Read-Only Status für eigene Zeile)
- Mail-Versand 🔔 + WhatsApp-Modal 💬 (pro Person + Sammel)
- Crew-Wechsel-Workflow + Auto-Merge bei Ghost→Real-E-Mail-Kollision
- Crew-Anlage ohne E-Mail
- Vitest-Tests gegen Test-Szenario „Yacht-Anzahlung mit Kojen, 2 Tranchen, 1 Crew-Wechsel"

### Phase 2 — Selbstmeldung (Migration 0025) — erledigt
- Crew-Button „Ich habe gezahlt" → `transactions.confirmed_at = NULL` (= pending)
- Vorstrecker-Bestätigungs-Workflow (✓/✗ in der Matrix)
- Mail-Notifications an den Vorstrecker bei Selbstmeldung
- Status-Symbol ⏳ + Pending-Banner

### Out of Scope
- ~~Automatische Erinnerungs-Mails~~ → **Implementiert** als Cron-Job (Migration 0028 + `/api/cron/prepayment-reminders`, täglich, 3 Tage vor Frist).
- Wero-API-Anbindung — nicht öffentlich verfügbar
- Wero-Klick-Links — entfernt, weil Wero keine offene Schnittstelle bietet
- IBAN-Fallback — bewusste Entscheidung
- Pro-Person-Override der Tranchen-Prozente — bewusste Entscheidung (einheitlich für alle)

## Test-Szenario (für Vitest)

Wird in `__tests__/prepayments.test.ts` umgesetzt, sobald die Implementierung beginnt.

**Setup:**
- Trip „Ostsee 2027", 7 Tage, Crew 5 Personen (Anna, Ben, Clara, David, Eva)
- Skipper: Jannik
- Aufteilung: Nach Kojen
  - Einzelkoje 1.000 € → Anna
  - Doppelkoje 800 € pro Person → Ben + Clara
  - Stockkoje 500 € pro Person → David + Eva
- 2 Tranchen: 30 % bei Buchung, 70 % zwei Wochen vor Törn

**Erwartete Soll-Beträge:**

| Person | Gesamt | Tranche 1 (30 %) | Tranche 2 (70 %) |
|---|---|---|---|
| Anna | 1.000 € | 300 € | 700 € |
| Ben | 800 € | 240 € | 560 € |
| Clara | 800 € | 240 € | 560 € |
| David | 500 € | 150 € | 350 € |
| Eva | 500 € | 150 € | 350 € |

**Ablauf:**
1. Skipper überweist 1.110 € an Charter (= 30 % von 3.700 € Gesamt) → Buchung mit Tranche 1. Bordkasse-Saldo Skipper bleibt 0 €, Anzahlungs-Pool: Skipper −1.110 €.
2. Anna zahlt voll Tranche 1 (300 €) → Anzahlungs-Pool: Anna +300, Skipper −810.
3. Ben zahlt nur 100 € (Teilzahlung) → Status ◐, Rest 140 €.
4. Clara, David, Eva zahlen Tranche 1 voll → Anzahlungs-Pool ausgeglichen außer Ben (−140) und Skipper (+140… moment, das stimmt nicht — let me recompute).

> ⚠️ Bei Implementierung Mathe noch einmal sauber durchziehen — dies ist ein Skizzen-Szenario, nicht der finale Test.

5. Vor Tranche 2: David springt ab, Felix kommt nach. Action „Ersetzen": Felix erbt Davids Koje (Stockkoje), Felix erbt Davids 150 € Tranche-1-Zahlung (Gegen-Gutschrift Felix→David).
6. Skipper überweist Rest 2.590 € (= 70 %) an Charter → Buchung mit Tranche 2.
7. Ben zahlt jetzt 140 € (Tranche-1-Rest) + 560 € (Tranche 2) → Status ✅ überall.
8. Alle anderen zahlen Tranche 2 voll → Anzahlungs-Pool perfekt ausgeglichen.

**Bilanz nach Törn-Ende (vor Bordkasse-Settlement):**
- Anzahlungs-Pool: alle 0 €
- Bordkasse: noch nicht relevant, kommt im normalen Settlement

## Aufwand-Schätzung (historisch)

Ursprüngliche Planung — alle Punkte sind umgesetzt, der Aufwand-Block bleibt als Referenz drin. Tatsächliche Implementierung verlief grob auf dieser Linie, plus die später dazugekommenen Erweiterungen (Vorstrecker-Konzept, Charter-Reminder-Mail, Auto-Reminder-Cron, Notice-Mails, Bordkasse-Pool-Trennung — siehe Abschnitt „Implementierte Erweiterungen" oben).

| Komponente | Tage |
|------------|------|
| DB-Migration + Server Actions (Kojen, Tranchen, Obligations, transactions.tranche_id) | 1,0 |
| Skipper-UI „Anzahlungen verwalten" (Wizard + Matrix) | 1,5 |
| Bilanz-Erweiterung (drei Blöcke) + Crew-Sicht (Read-Only) | 1,0 |
| Mail-Templates + WhatsApp-Modal (pro Person + Sammel) | 0,5 |
| Crew-Wechsel-Workflow + Crew-Anlage ohne E-Mail | 0,5 |
| Vitest + Playwright-Tests | 0,5 |
| **Phase 1 Gesamt** | **~5 Tage** |
| Phase 2 (Selbstmeldung) | ~1 Tag |
