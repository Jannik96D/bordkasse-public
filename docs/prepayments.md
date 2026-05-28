# Anzahlungs-Tranchen — Spec

Modul zur Erfassung, Planung und Nachverfolgung von Anzahlungen, die Crew-Mitglieder lange **vor** dem Törn an den Skipper leisten — typischerweise als Beteiligung an der Yacht-Charter, die der Skipper bereits Monate vor Reisebeginn buchen und (in Tranchen) bezahlen muss.

> Status: Design-Spec, noch nicht implementiert. Iteriert mit Jannik am 28.05.2026.

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
  trip_id        UUID PK REFERENCES trips(id) ON DELETE CASCADE
  split_method   TEXT CHECK (split_method IN ('gleichmaessig','zeitanteilig','individuell','kojen'))
  total_amount   NUMERIC(10,2)  -- Gesamt-Anzahlungssumme (z.B. Yacht-Charter-Preis)
  wero_id        TEXT           -- Wero-ID des Skippers (Mobil/E-Mail), optional pro Trip
  whatsapp_template TEXT        -- Editierbare Vorlage mit Platzhaltern

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
  id             UUID PK
  trip_id        UUID REFERENCES trips(id) ON DELETE CASCADE
  due_date       DATE
  label          TEXT  -- z.B. '1. Anzahlung', 'Endzahlung'
  percent        NUMERIC(5,2)  -- 0..100, Summe aller Tranchen eines Trips = 100
  wero_request_link TEXT NULL  -- optional: vom Skipper aus Wero-App kopierter Request-Link
  sort_order     INT

-- Bestehende transactions-Tabelle bekommt eine Spalte:
transactions
  + tranche_id   UUID NULL REFERENCES prepayment_tranches(id) ON DELETE SET NULL
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

### Weg 3 — Crew-Selbstmeldung (Phase 2)

Crew-Mitglied sieht in seiner Trip-Sicht den eigenen Tranchen-Status + Button **„Ich habe gezahlt"**:
- Klick → erzeugt Eintrag mit Status `pending_confirmation`
- Skipper bekommt Mail + Hinweis in der Matrix (Symbol ⏳)
- Skipper bestätigt mit einem Klick → Status ✅
- Bei Ablehnung: Eintrag wird verworfen, Crew-Member bekommt Mail mit Hinweis (kein freier Antwort-Text, um Streit zu vermeiden — Klärung per WhatsApp)

> Datenmodell-Erweiterung in Phase 2: Spalte `confirmed_at TIMESTAMPTZ NULL` auf `transactions` (oder eine separate Pending-Tabelle, je nach Komplexität bei der Implementierung).

## Status-Symbole

| Symbol | Bedeutung | Bedingung |
|--------|-----------|-----------|
| ⚠️ | Offen | keine Zahlung erfasst |
| ◐ | Teilweise | 0 < Σ Zahlungen < Soll |
| ✅ | Bezahlt | Σ Zahlungen ≥ Soll |
| ⏰ | Überfällig | `due_date < heute` UND Status ∈ {⚠️, ◐} |
| ➕ | Überzahlt | Σ Zahlungen > Soll (Guthaben in dieser Tranche) |
| ⏳ | Gemeldet, unbestätigt | nur Phase 2: Crew hat „Ich habe gezahlt" geklickt, Skipper hat noch nicht bestätigt |

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

Beide Versand-Wege werden manuell durch Skipper ausgelöst, kein Auto-Trigger.

### Erinnerungsmail an Crew

Pro Person-Zeile in der Matrix ein Knopf 🔔. Mail-Template ähnlich Settlement-Mail (siehe `lib/email/`):
- Anrede mit Display-Name
- Liste der offenen Tranchen mit Soll-Betrag und Fälligkeitsdatum
- Wero-ID des Skippers + ggf. Wero-Request-Link der Tranche
- Link zur Trip-Übersicht (führt nach Login auf eigene Anzahlungs-Sicht)

Voraussetzung: Crew-Mitglied hat E-Mail-Adresse. Sonst ist der 🔔-Button deaktiviert mit Tooltip „E-Mail fehlt".

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

- **Profil-Feld:** `prepayment_plan.wero_id` pro Trip (Mobilnummer oder E-Mail des Skipper-Wero-Accounts). Wird in den Trip-Settings eingegeben.
- **Tranche-Feld:** `prepayment_tranches.wero_request_link` — optional pro Tranche, vom Skipper aus der Wero-App per Copy-Paste eingefügt.
- **Crew-Sicht:** „Jetzt via Wero zahlen"-Button — wenn `wero_request_link` gesetzt ist, öffnet er den Link; sonst zeigt er den `wero_id`-Text + Verwendungszweck-Vorlage zum manuellen Eingeben.
- **Kein IBAN-Fallback:** explizite Entscheidung. Crew ohne Wero muss sich beim Skipper melden.

> Wero hat aktuell **keine offene API** für Drittanbieter — wir können keine Request-Links **generieren**, nur vom Skipper bereitgestellte **wiederverwenden**.

## Sichtbarkeit

| Rolle | Sicht |
|---|---|
| Skipper / Co-Skipper / Admin | Komplette Matrix, alle Aktionen |
| Crew-Mitglied (eingeloggt) | Nur eigene Zeile mit eigenen Tranchen + „Jetzt zahlen"-Button |
| Ghost-Crew (kein Login) | Keine — nutzt nur die vom Skipper ausgelösten WhatsApp-Texte |

RLS-Policy auf `prepayment_obligations`: Self-Read für eigene `person_id`, Skipper-Read für gesamten Trip (analog zu `persons_private`).

## Phasen-Plan

### Phase 1 — Kern
- DB-Migration (4 Tabellen + `transactions.tranche_id`)
- Skipper-Wizard zwei Schritte (Aufteilung + Tranchen, inkl. Kojen-Editor)
- Anzahlungs-Matrix mit Status-Symbolen + Weg-1-Modal
- Erweiterung der Gutschrift-Maske (Weg 2) und Buchungs-Maske um Tranche-Dropdown
- Bilanz-Erweiterung (drei Blöcke)
- Crew-Sicht (Read-Only Status für eigene Zeile)
- Mail-Versand 🔔 + WhatsApp-Modal 💬 (pro Person + Sammel)
- Crew-Wechsel-Workflow
- Crew-Anlage ohne E-Mail
- Vitest-Tests gegen Test-Szenario „Yacht-Anzahlung mit Kojen, 2 Tranchen, 1 Crew-Wechsel"

### Phase 2 — Selbstmeldung
- Crew-Button „Ich habe gezahlt" → `pending_confirmation`-Status
- Skipper-Bestätigungs-Workflow
- Mail-Notifications an Skipper bei Selbstmeldung
- Erweiterung des Status-Symbols (⏳)

### Out of Scope
- Automatische Erinnerungs-Mails nach X Tagen — bewusste Entscheidung: nur manueller Knopf
- Wero-API-Anbindung — nicht öffentlich verfügbar
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

## Aufwand-Schätzung

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
