# Anzahlungs-Tranchen — Spec

Modul zur Erfassung, Planung und Nachverfolgung von Anzahlungen, die Crewmitglieder lange **vor** dem Törn an den Skipper oder einen anderen Vorstrecker leisten — typischerweise als Beteiligung an der Yacht-Charter, die der Skipper bereits Monate vor Reisebeginn buchen und (in Tranchen) bezahlen muss.

> **Status: Implementiert** über Migrationen 0023–0028. Phase 1 (Kern) + Phase 2 (Crew-Selbstmeldung) + Auto-Reminder-Cron + Vorstrecker-Konzept + Charter-Reminder-Mail sind live. Diese Spec spiegelt den aktuellen Stand und beschreibt die Mechanik im Detail.

> **Sprachregelung:** „Vorstrecker" ist in dieser Spec der interne Konzept-Name (Code-Identifier `advancer_*`, `requireSkipperAdminOrAdvancer`). In **Endnutzer-Texten (UI/Mail)** wird die Rolle geschlechtsneutral formuliert: Badge „Streckt vor", sonst „die vorstreckende Person" bzw. das Verb „vorstrecken". Analog werden „Schuldner/Gläubiger" im UI als „wer zahlt / wer das Geld bekommt" ausgedrückt.

## Problem

Ein realer Fall: Skipper bucht die Yacht 10 Monate vor dem Törn und streckt die Anzahlung vor. Crewmitglieder sagen zu und überweisen ihre Beteiligung **in unterschiedlichem Tempo** — manche sofort, manche erst kurz vor Törn-Start, manche gar nicht. Zwischendurch fällt Person A ab, Person B rückt nach; B übernimmt die Anzahlung, die A bereits geleistet hatte.

Das aktuelle Modell (Buchung + Gutschrift + Bilanz) bildet das Geldfluss-Modell zwar mathematisch korrekt ab, lässt aber drei Lücken:

1. **Soll-Beträge** sind unsichtbar — die App weiß nicht, was eine Person eigentlich zahlen sollte, sondern nur, was sie bezahlt hat.
2. **Mehrere zeitliche Tranchen** (z.B. 30 % bei Buchung, 70 % drei Monate vor Törn) sind nicht modelliert.
3. **Individuelle Beträge** (Stockkoje günstiger, Einzelkoje teurer) lassen sich zwar mit Aufteilung „Pro Person" abbilden, aber nicht **vor** der eigentlichen Yacht-Buchung planen.

## Begriffe

| Begriff | Definition |
|---|---|
| **Anzahlungs-Plan** | Pro Trip eine Konfiguration: Aufteilungsmethode + Kojen-Definition + Tranchen-Liste |
| **Tranche** | Ein Zahlungstermin mit Fälligkeitsdatum, Label und Prozent-Anteil am Gesamt-Soll |
| **Soll-Betrag (Obligation)** | Was eine Person für eine Tranche zahlen muss — abgeleitet aus Aufteilungsmethode |
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

-- Nur wenn split_method = 'kojen': Kojentypen mit Preis pro Person
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
  due_date          DATE          -- Charterfrist gegenüber dem Vercharterer (Crewfrist = due_date − 3 Tage)
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

## Aufteilungsmethoden (Schritt 1 im Wizard)

### 1. Gleichmäßig
`total_amount` wird gleich auf alle Crewmitglieder verteilt.

### 2. Zeitanteilig
Verteilung nach Bord-Tagen (siehe `calculation-rules.md` → „Zeitanteilig").

> **Cent-genaue Verteilung (Fix C-3):** `gleichmaessig` und `zeitanteilig`
> verteilen per Largest-Remainder (`allocateByWeights` in `lib/calc/
> prepayment-shares.ts`, in Cent gerechnet) — die Summe der Personen-Soll
> ergibt EXAKT `total_amount` (vorher rundete jede Person einzeln, z. B.
> 1000/3 → 3×333,33 = 999,99, und der Vorstrecker sammelte 1 ct zu wenig ein).
> `individuell`/`kojen` sind Pass-through (Beträge kommen direkt vom Skipper
> bzw. Kojenpreis).

### 3. Individuell
Skipper tippt pro Person einen Betrag.

### 4. Nach Kojen
- Skipper definiert Kojentypen mit **Preis pro Person**:
  ```
  Einzelkoje:  1 × 1.200 € pro Person   (Kapazität: 1)
  Doppelkoje:  2 × 800 € pro Person     (Kapazität: 2)
  Stockkoje:   1 × 500 € pro Person     (Kapazität: 2)
  ```
- Jede Crew bekommt per Dropdown eine `cabin_type_id` zugeordnet.
- Kapazität wird beim Speichern validiert: max. `Σ capacity` Plätze.
- Soll = `cabin_type.price_per_person`.
- Bei „Pro Person"-Eingabe gilt: der Preis wird so eingetippt, wie ihn der Charterer angibt — z.B. „Doppelkoje 800 € pro Person" heißt: beide Bewohner zahlen je 800 €. Doppel-belegt = doppelter Erlös für den Charterer.
- **Σ-Abgleich (nicht-blockierend):** Weicht die Summe der zugeordneten Kojenpreise von der eingetragenen Gesamtsumme ab (> 0,005 €), zeigt der Wizard eine Hinweiszeile („Σ Kojen X € weicht von der Gesamtsumme Y € ab — die Differenz läuft über die Bordkasse"). Blockiert das Speichern **nicht** — der Rest wird bewusst über die laufende Bordkasse abgerechnet.

### Gesamtsumme ist Pflicht — auch bei „Individuell" / „Nach Kojen" (Migration 0056)

Früher durfte das Feld „Gesamtsumme der Anzahlung" bei diesen beiden Methoden
leer bleiben (das Soll kommt dort aus Einzel- bzw. Kojenpreisen; der Wizard
blockte „Weiter" nur bei `gleichmaessig`/`zeitanteilig`).

`prepayment_plan.total_amount` ist aber **gleichzeitig das Charter-Soll**
(was der Vorstrecker dem Vercharterer schuldet). Eine leere Eingabe landete
als `0` und machte alles kaputt, was gegen den Vercharterer rechnet:

- Tranchen-Vorbelegung im Buchungsformular setzte **0,00 €** statt
  `total_amount × percent / 100` (der eigentliche Grund für „die Vorbelegung
  der Yachtanzahlung funktioniert nicht" — das Betragsfeld hat „0,00" als
  Platzhalter, die Vorbelegung war also nicht mal sichtbar).
- Charter-Reminder-Banner + Fortschritts-Prozent in der Matrix zeigten 0 €.
- `advancerOwes` in `getPrepaymentNavState` hielt die Anzahlung für
  vollständig überwiesen (steuert u. a. die Sichtbarkeit des Tranchen-Felds).
- Die Vorstrecker-Erinnerung (`advancer_3d`) fiel aus demselben Grund aus.

**Verhalten jetzt:** Die Gesamtsumme ist für **jede** Methode Pflicht —
`PlanSchema` verlangt `> 0` (`lib/validation/prepayment-schema.ts`), der
Wizard deaktiviert „Speichern & weiter" solange sie fehlt. Damit es kein
Abtippen bedeutet, zeigt der Wizard bei `individuell`/`kojen` einen Button
**„Σ Soll übernehmen (X €)"** (sobald Σ Soll > 0 ist und von der Eingabe
abweicht — bei noch leeren Kojenpreisen also nicht), und der Σ-Abgleich-Hinweis existiert jetzt auch
für `individuell` (vorher nur für `kojen`). Eine Abweichung von Σ Soll bleibt
erlaubt — die Differenz läuft laut Σ-Abgleich über die Bordkasse.

> **Warum nicht automatisch ableiten?** Ein erster Fix leitete `total_amount`
> im Schreibpfad aus Σ Soll ab, wenn das Feld leer war. Der Grill-Review fand
> den Folgebug: der Wizard belegt das Feld beim nächsten Öffnen mit dem
> abgeleiteten Wert vor, der damit zum „bewusst gesetzten" wird — ändert der
> Skipper danach eine Koje oder einen Einzelbetrag, läuft die Plansumme still
> davon weg (bei `individuell` ohne jede Warnung). Ein abgeleiteter Wert ist
> nach dem Speichern nicht mehr von einem gewollten unterscheidbar. Deshalb:
> eine Quelle der Wahrheit, ein Klick zum Übernehmen.

Migration 0056 ist eine **Einmal-Reparatur** der Bestandsdaten (Pläne mit
`total_amount = 0` bekommen Σ Soll), keine dauerhafte Ableitung.

## Tranchen (Schritt 2 im Wizard)

Skipper definiert eine Liste von Tranchen mit `due_date` + `percent`. Validierung: `Σ percent = 100` (Toleranz ±0,01). Das **Label wird automatisch durchnummeriert** (`trancheLabel(index, total)`): alle bis auf die letzte heißen „N. Anzahlung", die letzte „Endzahlung" (bei nur einer Tranche → „Endzahlung"). Kein freies Label-Feld — schlankeres Design, weniger Tipp-Aufwand. Beispiel:

```
Tranche 1: "1. Anzahlung" — fällig 15.07.2026 — 30 %
Tranche 2: "Endzahlung"   — fällig 01.01.2027 — 70 %
```

Tranchen-Aufteilung gilt **einheitlich für alle Crew** — keine pro-Person-Overrides. Wenn eine Person eine Tranche überzahlt, kann das Modal (siehe „Spezialfälle") den Überschuss auf eine andere Tranche umbuchen.

## Eingangs-Erfassung (Crew → Skipper)

Drei Eingangspunkte; in Phase 1 nur Weg 1 + 2, Weg 3 folgt in Phase 2.

### Weg 1 — Aus der Anzahlungs-Matrix (primär)

Anzahlungs-Übersicht zeigt die Soll-Matrix Crew × Tranche mit Statussymbolen:

```
                Tranche 1 (15.07.)            Tranche 2 (01.01.27)
Anna           ⚠️ 240 € offen   ← Klick       ⚠️ 560 € offen
Ben            ◐ 100/240 € am 18.07.          ⚠️ 560 € offen
Clara          ✅ 240 € am 12.07.             ⚠️ 560 € offen
```

Klick auf eine offene/teilweise Zelle öffnet ein Modal:

```
┌─ Zahlung von Anna erfassen ──────────┐
│ Tranche 1 — 1. Anzahlung             │
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

Crewmitglied sieht in seiner Trip-Sicht (CrewSelfView) den eigenen Tranchen-Status + Button **„Ich habe gezahlt"**:
- Klick → erzeugt eine reguläre Gutschrift mit `confirmed_at = NULL` (= pending). Der Empfänger ist der **Vorstrecker** des Trips, nicht zwingend der Skipper.
- Vorstrecker bekommt Mail (`payment-pending-template.ts`) + Hinweis in der Matrix (Symbol ⏳, Pending-Banner mit ✓/✗-Buttons). Der Banner-Eintrag zeigt nur „X hat Y € für N. Anzahlung gemeldet" + Datum — die Buchungs-Beschreibung wird bewusst nicht gerendert (redundant zur Zeile darüber).
- Vorstrecker bestätigt mit ✓ → `confirmed_at = now()`, Eintrag zählt ab sofort in `v_prepayment_payments`
- Bei Ablehnung mit ✗ → Soft-Delete via `deleted_at`. Crewmitglied bekommt eine Notice-Mail mit Hinweis „sprich mit dem Vorstrecker, falls das ein Versehen war" (kein freier Antwort-Text, um Streit zu vermeiden — Klärung per WhatsApp)

**Datenmodell:** `transactions.confirmed_at TIMESTAMPTZ NULL DEFAULT now()` aus Migration 0025. Normale Skipper-/Admin-/Vorstrecker-Eingaben sind dadurch sofort bestätigt, nur `submitSelfPayment` schreibt explizit `NULL`. View `v_prepayment_pending` aus derselben Migration listet alle offenen Selbstmeldungen.

## Statussymbole

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

**Reihenfolge ist egal:** der Skipper kann die Charteranzahlung erst überweisen und dann die Crew-Eingänge erfassen, oder umgekehrt. Der Anzahlungs-Pool-Saldo zeigt zu jedem Zeitpunkt den korrekten Stand.

**Auto-Vorbelegung (implementiert):** Wählt man im Ausgabe-Formular eine Tranche, füllt die Maske automatisch **Betrag** (= `prepayment_plan.total_amount × tranche.percent / 100`), **Beschreibung** (= Tranchen-Label, z. B. „1. Anzahlung") und **Kategorie** (= Törn-Kategorie mit „Yacht" im Namen; fehlt sie, bleibt die Kategorie unangetastet) vor — der häufige Fall „Charter-Überweisung erfassen", ohne den Betrag aus dem Plan abzutippen. Das Datum bleibt auf heute. „Smart overwrite": es werden nur leere oder noch automatisch gefüllte Felder gesetzt, manuell Eingegebenes bleibt; ein Tranchen-Wechsel aktualisiert die Vorbelegung, „Keine" leert nur die Auto-Werte. Reine Logik: `lib/prepayments/tranche-autofill.ts:computeTrancheAutofill` (Vitest). Das Gutschrift-Formular bekommt bewusst KEIN Autofill — Crew-Anteile laufen über die Matrix (`recordPayment`), wo der Betrag personenabhängig ist.

Ist keine Plansumme (> 0) vorhanden, wird der **Betrag gar nicht** vorbelegt (`amount: undefined` in `transactions/new/page.tsx` + `[txId]/edit/page.tsx`) statt einer sinnlosen 0,00 € — siehe „Gesamtsumme bei Individuell / Nach Kojen". Im **Edit-Modus** greift die Vorbelegung erwartungsgemäß nicht, wenn Betrag/Beschreibung/Kategorie schon gefüllt sind: „Smart overwrite" schützt hier bestehende Werte.

**Berechtigung (UI + Server):** Das Tranche-Feld ist nur für Skipper/Co-Skipper/Admin/Vorstrecker sichtbar (`canEditTranche`). Weil Server Actions mit dem Service-Role-Client schreiben (RLS umgangen), erzwingen `createExpense`/`updateExpense` dieselbe Rolle zusätzlich im App-Layer: eine Buchung darf nur dann eine `tranche_id` tragen, wenn `requireSkipperAdminOrAdvancer` erfüllt ist — sonst könnte ein gewöhnliches Crewmitglied (das via `requireMember` normale Bordkasse-Buchungen anlegen darf) eine Ausgabe per manipuliertem Request in den Anzahlungspool schieben. `updateExpense` nutzt einen `tranche_field_present`-Marker (vom Formular nur gerendert, wenn das Feld sichtbar ist), um „Feld nicht angezeigt" von „bewusst auf Keine gesetzt" zu unterscheiden → fehlt der Marker, bleibt die bestehende Zuordnung unverändert (kein versehentliches Lösen aus dem Pool durch einen nicht-berechtigten Ersteller). Gutschriften sind über `requireSkipperOrAdmin` ohnehin Skipper/Admin-only.

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

### Crewmitglied ohne E-Mail-Adresse
Skipper darf Crew anlegen, ohne E-Mail-Adresse zu kennen:
- `inviteMember`-Schema in `lib/actions/trip-members.ts:14` muss von `.email(...)` auf `.email(...).optional().or(z.literal(""))` umgestellt werden
- Logik verzweigt: mit E-Mail → wie heute inkl. Auto-Invite-Mail; ohne E-Mail → nur `persons.display_name`, `persons_private` bleibt leer
- Crew kann **trotzdem**: Koje zugewiesen bekommen, Soll-Beträge erhalten, Zahlungen via Weg 1 erfasst werden, in Buchungen verwendet werden, WhatsApp-Text generiert werden
- Crew kann **nicht**: sich einloggen, Erinnerungsmail empfangen, Phase-2-Selbstmeldung nutzen
- Sobald E-Mail nachgetragen wird (Inline-Edit): Auto-Invite-Mail wird **dann** ausgelöst (wie heute beim Anlegen)
- UI-Indikator: blasses Warn-Symbol neben Crew-Namen in der Liste, solange E-Mail fehlt

## Crew-Wechsel-Workflow

Action **„Crewmitglied ersetzen"** (⇄-Icon in der Crew-Verwaltung, `replaceMember`
in [`lib/actions/prepayments.ts`](../webapp/lib/actions/prepayments.ts)). Für die
Anzahlung gilt in beiden Modi die Annahme aus der Iteration: **„Ersatz übernimmt
Anzahlung direkt"** — B hat A privat ausbezahlt, deshalb wandern Soll UND bereits
geleistete Zahlungen auf B. Die App bildet die private Rückzahlung B → A bewusst
nicht ab; sie steht nur als `transferred_sum` im Audit-Log.

Der Skipper wählt im Formular explizit einen von zwei Modi.

### Modus 1 — „hat abgesagt und war nie dabei" (nur vor Törnbeginn)

1. B wird als neue Person + Crewmitglied angelegt (ggf. ohne E-Mail als Ghost).
2. B übernimmt A's Anwesenheitsfenster, `cabin_type_id`, `prepayment_obligations`
   und — seit Fund F5 — auch A's `is_skipper`-Rolle (sonst stünde die Crew nach
   dem Wechsel ohne handlungsfähigen Co-Skipper da).
3. **Alle** Gutschriften von A (`credit_from`, Pool UND Bordkasse) werden per
   `UPDATE` auf B umgehängt — keine kompensierende Gegen-Gutschrift. Grund:
   `v_balances` ist rein mitgliedschaftsgetrieben, eine Zeile mit `credit_from`
   auf eine nicht mehr in `trip_members` stehende Person fällt spurlos aus der
   Bilanzsumme (Σ ≠ 0, `all_debts_settled` nie wahr → Purge-Blocker).
   Selbstverrechnungen (`credit_from = credit_to`) sind ausgenommen.
4. A wird **wirklich gelöscht** (`DELETE FROM trip_members`), nicht auf
   `on_board_from/to = NULL` gesetzt — NULL bedeutet laut Schema volle
   Anwesenheit, also exakt das Gegenteil der Absicht. Vorher wird A's
   `trip_statistics_audience`-Zeile gesichert (sonst verliert A den Törn aus
   `/stats`) und `settled_debts` + `prepayment_reminder_log` aufgeräumt.
5. Setzt voraus, dass an A keine Buchungsspur mehr hängt (`paid_by`,
   `credit_to`, `transaction_participants`) — sonst Block mit Fehlermeldung.

### Modus 2 — „ist abgereist am …" (Variante b, Pflicht sobald der Törn läuft)

Existiert, weil `v_transaction_shares` die Crew **ausschließlich** aus
`trip_members` ableitet und für `equal`/`on_board`/`time_proportional` keine
Anteile speichert: löscht man A mitten im Törn, werden **rückwirkend auch alle
Ausgaben vor dem Wechsel** auf B umverteilt. A ginge mit 0 € raus, B zahlte A's
Einkäufe mit. Verifiziert mit `calculateShares`: 300 € „gleichmäßig" am 03.08.
bei Crew {S, A} → S 150 / A 150; nach dem Löschen von A → S 150 / **C 150**.

**⚠️ Was Modus 2 NICHT repariert — „Gleichmäßig".** Das aktive Set ist dort
laut `is_in_active_set` schlicht `TRUE`, also ALLE `trip_members`, völlig
datumsblind. Ein zusätzliches Mitglied senkt damit rückwirkend den Anteil aller
an jeder bisherigen „Gleichmäßig"-Ausgabe. Numerisch (14-Tage-Törn, 4 Personen,
400 € an Tag 2, Wechsel an Tag 7):

| Aufteilung | vorher | nachher |
|---|---|---|
| `equal` | X/Y/Z/A je 100 € | X/Y/Z/**A je 80 €**, **B 80 €** |
| `time_proportional` | je 100 € | X/Y/Z je 98,25 €, A 49,12 €, B 56,14 € |
| `on_board` | je 100 € | **unverändert je 100 €, B 0 €** ✓ |

`on_board` (und `individual`/`per_person`) sind also korrekt. `equal` und
`time_proportional` sind BEIDE datumsblind — bei `time_proportional` ist der
Anteil `amount * days / active_days`, das Buchungsdatum kommt in der Formel
schlicht nicht vor.

**Der Effekt geht in beide Richtungen.** Rückwärts zahlt der Nachrücker an
Ausgaben von vor seiner Ankunft mit (Tabelle oben). Vorwärts bleibt die
abgereiste Person Crewmitglied und zahlt bei `equal` einen **vollen Anteil an
jeder Ausgabe nach ihrer Abreise** — 300 € Lebensmittel an Tag 8 nach einem
Wechsel an Tag 5 belasten A mit 60 €, obwohl A längst zu Hause ist. Auch
Gutschriften „An Alle" (`credit_to_all`) sind betroffen: `credit_received_alle`
in 0043 verteilt `/(n-1)` ohne Datumsbezug.

Deshalb warnt das Formular vor dem Absenden mit der **Zahl aller betroffenen
Buchungen des Törns** — bewusst nicht nur derer vor dem Wechseltag
(`countPresenceBlindBookings` in
[`lib/queries/date-blind-expenses.ts`](../webapp/lib/queries/date-blind-expenses.ts)):
`equal`- und `time_proportional`-Ausgaben plus „An Alle"-Gutschriften. Der
Skipper kann sie vorher auf „An Bord" umstellen. Bewusst keine automatische
Umschreibung — das wäre eine irreversible Änderung an fremden Buchungen.

**Fazit für die Praxis:** ein Törn mit Crewwechsel sollte durchgängig „An Bord"
(oder Individuell/Pro Person) verwenden. „Gleichmäßig" lässt sich mit einem
Wechsel mitten im Törn grundsätzlich nicht korrekt abbilden — weder mit noch
ohne Variante b.

1. Das Formular verlangt einen **Wechseltag**; er muss im Törnzeitraum *und* im
   Anwesenheitsfenster von A liegen.
2. A **bleibt in der Crew**, `on_board_to` endet am Wechseltag. A zahlt damit
   weiter für die eigenen Tage, keine historische Ausgabe wird umverteilt.
3. B startet am Wechseltag und läuft bis zu A's ursprünglichem Ende. Der
   Übergabetag gehört bewusst **beiden** — an einem Crewwechsel-Tag sind
   Abreisende und Nachrücker typischerweise zusammen an Bord.
4. Nur **tranche-getaggte** Gutschriften (= Anzahlungszahlungen) wandern auf B.
   Bordkasse-Gutschriften bleiben bei A — A ist ja noch da, es ist weiterhin
   A's eigenes Geld.
5. `is_skipper` wandert **nicht** mit (A behält die Rolle), keine
   `trip_statistics_audience`-Zeile nötig (A bleibt Mitglied), kein
   `settled_debts`-Cleanup (A's Häkchen bleiben gültig).
6. Der Buchungsspur-Check entfällt — dass A Buchungen hat, ist hier der
   Normalfall und genau der Grund für diesen Modus.

**⚠️ Bekannte Grenze von Modus 2:** nach einem Wechsel mitten im Törn sind A UND B
Crewmitglieder. Speichert der Skipper danach den **Anzahlungsplan neu**, verteilt
`savePrepaymentPlan` → `calculateObligations` das Charter-Soll über alle aktuellen
Mitglieder — bei `zeitanteilig` korrigiert sich das selbst (A und B haben zusammen
die Tage einer Koje), bei `gleichmaessig` bekäme die eine Koje zwei volle Anteile.
In der Praxis kaum relevant, weil die Anzahlung typischerweise lange vor Törnbeginn
abgeschlossen ist. Ein sauberer Fix bräuchte ein „zählt für die Anzahlung"-Flag auf
`trip_members` — bewusst nicht gebaut.

Ob Modus 1 überhaupt erlaubt ist, entscheidet der Server: sobald der Törn
begonnen hat **oder** eine Bordkasse-Buchung (`tranche_id IS NULL`) **mit Datum
ab Törnbeginn** existiert, ist ein Wechseltag Pflicht. Zwei bewusste Ausnahmen,
sonst wäre der häufigste Fall überhaupt — Absage vor dem Törn — blockiert:
Anzahlungsbuchungen entstehen planmäßig Monate vorher und werden ohnehin
explizit übertragen; und Bordkasse-Buchungen dürfen laut Spec ein Datum VOR dem
Törn tragen (Versicherung, Vorab-Einkauf).

Den Modus bestimmt das Radio (`repl_mode`), **nicht** allein die Anwesenheit des
Datumsfelds: ohne JavaScript schickt der Browser das Feld auch dann mit, wenn
der Nutzer „hat abgesagt" gewählt hat — explizites `cancelled` gewinnt.
Symmetrisch wird `handover` ohne Datum **abgelehnt** statt in den Lösch-Pfad zu
fallen (bei einem Törn ohne Buchungen greift der `tripUnderway`-Guard nicht).

In beiden Modi setzt die Action `mark_post_settlement_change` (Fund F2): ein
Crewwechsel verändert die Bilanz, nach verschickter Abrechnung muss die Crew
deshalb den „Bilanz hat sich geändert"-Banner sehen.

**⚠️ `new_person_id` ist client-kontrolliert** (Hidden-Input für die
Retry-Idempotenz) und darf deshalb **nur eine Neuanlage** adressieren — der
Guard `assertFreshPersonId` weist jede bereits vergebene ID ab, und geschrieben
wird mit `insert`, nicht `upsert` (Fund F1). Vorher ließ sich damit über den
Service-Role-Client eine fremde Ghost-Person überschreiben (`display_name` +
`persons_private.email`) und anschließend per Ghost-Verlinkung übernehmen.

**Edge Case Crew-Wechsel zwischen Tranchen:** A hat Tranche 1 voll bezahlt, ist vor Tranche 2 abgesprungen. B übernimmt → bekommt Tranche-1-Status „bezahlt" geerbt, Tranche-2-Soll auf B.

## Mail-Templates + WhatsApp-Texte

WhatsApp-Versand läuft immer manuell. Mail-Versand läuft entweder manuell (🔔-Button) oder automatisch via Cron (siehe „Implementierte Erweiterungen" → Auto-Reminder).

Alle Mails nutzen [`lib/email/mail-shell.ts`](../webapp/lib/email/mail-shell.ts) — gemeinsamer Logo-PNG-Header + Card + Footer.

### Erinnerungsmail an Crew (`prepayment-reminder-template.ts`)

Pro Person-Zeile in der Matrix ein Knopf 🔔, plus Auto-Versand vom Cron innerhalb der letzten 3 Tage vor Crew-Fälligkeit. Crew mit pending Selbstmeldung wird automatisch übersprungen. Inhalt:
- Anrede mit Display-Name
- Liste der offenen Tranchen mit Soll-Betrag und Crew-Fälligkeitsdatum (= Charterfrist minus 3 Tage)
- Dynamischer Wero-Hinweis: „Bitte schicke **{Vorstrecker}** per Wero die fällige Anzahlung." mit Wero-ID + Verwendungszweck als Pille. **Kein Klick-Link** — Wero hat keine offene API. Falls keine Wero-ID gepflegt: „Frag {Vorstrecker} nach den Überweisungsdetails."
- Hint-Block am Mail-Ende erklärt die Wero-Limitation
- Link zur Bordkasse (`/trips/{id}/prepayments`)

Voraussetzung: Crewmitglied hat E-Mail-Adresse. Sonst ist der 🔔-Button deaktiviert mit Tooltip „E-Mail fehlt".

### Charter-Reminder-Mail an den Vorstrecker (`charter-reminder-template.ts`)

In der Matrix-Zeile des Vorstreckers schickt der 🔔-Button **nicht** seine persönlichen Tranchen, sondern eine Charter-Übersicht pro Tranche:
- Soll Vercharterer (Tranchen-Prozent × `total_amount`)
- Σ Crew-Eingänge bei dir vs. Σ Crew-Soll
- Schon an Vercharterer überwiesen (Σ expense-Buchungen mit dieser Tranche)
- Noch zu überweisen

Wird auch automatisch vom Cron innerhalb der letzten 3 Tage vor Charter-Fälligkeit verschickt — aber nur wenn der Vorstrecker dem Vercharterer noch was schuldet (`remaining_to_agency > 0`). „Crew bei dir" und „Σ Crew-Soll" klammern den Vorstrecker selbst aus, sein treuhänderischer Eigen-Anteil fließt nicht in diese Zahlen ein. In der Matrix ist die Vorstrecker-Glocke disabled, wenn nichts mehr offen ist. Routing-Logik: `personId === advancer_person_id` → Charter-Pfad; sonst Crew-Pfad.

### Selbstmeldungs-Benachrichtigung (`payment-pending-template.ts`)

Geht an den Vorstrecker, wenn ein Crewmitglied „Ich habe gezahlt" geklickt hat. Enthält Tranche-Label, Crew-Fälligkeit, Betrag, optionale Notiz, Direktlink zur Matrix zum Bestätigen.

### Notice-Mails bei Admin-Aktionen (`prepayment-notice-template.ts`)

Generisches Template mit drei Varianten:
- `payment_recorded` → wenn jemand für eine andere Person eine Zahlung erfasst hat
- `payment_confirmed` → wenn jemand eine Selbstmeldung bestätigt hat (Empfänger: Vorstrecker, falls Actor ≠ Vorstrecker)
- `payment_rejected` → wenn jemand eine Selbstmeldung abgelehnt hat (Empfänger: Crew-Person + Vorstrecker, falls Actor ≠ beide)

Self-Aktionen (Crew meldet selbst, Vorstrecker bestätigt selbst) erzeugen keine Notice-Mail.

Bei Overzahlung mit Overflow-Split in `recordPayment` (part1 auf gewählte Tranche, part2 auf overflow_tranche_id) geht **pro gebuchter Tranche eine eigene Notice-Mail** mit dem jeweiligen Teilbetrag raus — nicht eine Mail mit Gesamtbetrag auf der ersten Tranche.

### Observer-Mail bei Bordkasse-Schulden (`debt-observer-template.ts`)

Wenn eine **dritte Person** (Admin) eine Schuld zwischen zwei Crewmitgliedern abhakt, bekommen Skipper und Vorstrecker (sofern sie nicht ohnehin Schuldner/Gläubiger sind) eine neutrale Info-Mail mit dem Wortlaut „Schuld zwischen A und B abgehakt" — nicht die normale debt-settled-Mail, die sie sonst irreführend als Gläubiger/Schuldner adressieren würde. Eigenes Template über `mail-shell.ts`, eigene `"observer"`-Rolle im recipients-Array.

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

Über der Matrix ein Button **„Sammelnachricht für alle Offenen erzeugen"**. Öffnet Modal mit einem Block pro Person mit offenem/teilweisem Status — als ein zusammenhängender Text, den der Skipper in eine WhatsApp-Gruppe einfügen kann. Personen ohne offene Posten werden ausgelassen.

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
| Crewmitglied (eingeloggt, kein Manage-Recht) | CrewSelfView: nur eigene Zeile mit eigenen Tranchen + „Ich habe gezahlt"-Button |
| Ghost-Crew (kein Login) | Keine — nutzt nur die vom Skipper ausgelösten WhatsApp-Texte |

RLS-Policy auf `prepayment_obligations` (**seit Migration 0057**): Read für die ganze Crew — `is_trip_member OR is_trip_skipper OR person_id = current_person_id()`, wie bei `prepayment_plan` / `prepayment_tranches` / `cabin_types`. Vorstrecker-Aktionen laufen über App-Layer-Authz (`lib/auth/authz.ts:requireSkipperAdminOrAdvancer`), Schreib-Pfad nutzt ohnehin den Service-Role-Client.

> **Warum geändert (Betriebsfund):** ursprünglich (0023) stand hier nur
> „Skipper ODER eigene Zeile" (analog `persons_private`). Die Bilanz-Seite
> rendert den Anzahlungs-Pool aber **ungegatet für jedes Crewmitglied**: das
> „bezahlt"-Ist kommt aus `transactions` (member-lesbar), das Soll aus dieser
> Tabelle. Ein normales Crewmitglied sah deshalb bei allen anderen `soll = 0`
> — und weil die Statuslogik `soll <= 0.005` als „bezahlt" wertet, stand
> neben „471,29 € / 0,00 €" ein grünes Häkchen: nicht bloß eine Lücke,
> sondern eine falsche Aussage (alle wirkten schuldenfrei). Zweiter Treffer
> derselben Lücke: ein Vorstrecker, der nicht Trip-Skipper ist, darf die
> Matrix laut App-Layer verwalten, bekam per RLS aber nur die eigene Zeile.
> Entscheidung: Transparenz — wer wie viel zur Anzahlung beisteuert, ist
> dieselbe Klasse geteilter Kassendaten wie die Bilanz, die ohnehin jedes
> Crewmitglied für die ganze Crew sieht. Regression:
> `supabase/tests/obligations_crew_read_test.sql`.

## Implementierte Erweiterungen (Stand heute)

Diese Punkte sind über die ursprüngliche Phase-1/Phase-2-Aufteilung hinaus dazugekommen:

- **Explizite Wahl „mit/ohne Anzahlung"** (Migration 0040 = `trips.prepayment_declined_at`): Bei der Törn-Anlage wählt der Skipper per Radio, ob eine Anzahlung vorgesehen ist (Default „mit"); umentscheiden geht jederzeit in den Trip-Settings (Sektion „Anzahlungsplan", Action `setPrepaymentDeclined`). Dreizustand: Plan existiert → Charter (gewinnt immer, `savePrepaymentPlan` löscht das Flag); declined → kein Anzahlungs-CTA auf der Übersicht und kein „Anzahlungsplan anlegen"-Item in der Törn-Fortschritt-Karte; beides nicht → CTA + offenes Checklisten-Item als Erinnerung.
- **Vorstrecker-Konzept** (Migration 0024): `prepayment_plan.advancer_person_id` — wer streckt die Charteranzahlung tatsächlich vor (Default = Skipper, im Wizard editierbar). Alle Crew-Anzahlungen werden gegen diese Person verbucht. `tx_credit_self` relaxiert für tranche-getaggte Buchungen, damit der Vorstrecker seinen eigenen Anteil als Selbst-Verrechnung abhaken kann.
- **Crew-Fälligkeit 3 Tage vor Charter** (`lib/prepayments/dates.ts:toCrewDueDate`): die Charterfrist ist verbindlich gegenüber dem Vercharterer — die Crew soll 3 Tage vorher gezahlt haben, damit der Vorstrecker rechtzeitig überweisen kann. Wird konsistent in Matrix-Header, Crew-Self-View, WhatsApp-Vorlage und Mails angewandt; der Charter-Reminder-Banner zeigt weiter das Originaldatum. **Clamp:** `toCrewDueDate` lässt die Crewfrist nicht in die Vergangenheit rutschen, solange die Charterfrist noch aussteht, und nie hinter die Charterfrist selbst (sonst stünde z. B. „Crew bis gestern", obwohl die Zahlung noch ansteht). `today` ist als Parameter überschreibbar → deterministisch testbar (`__tests__/prepayment-dates.test.ts`).
- **Bordkasse vs. Anzahlungs-Pool getrennt** (Migrationen 0026 + 0027): `v_balances_bordkasse_only` und `simplify_debts_bordkasse_only` filtern auf `tranche_id IS NULL`. Die untere Bilanz-Tabelle zeigt bei aktivem Plan nur den Bordkasse-Saldo; der Anzahlungs-Pool steht oben als Drei-Block-Übersicht.
- **Charter-Reminder-Mail an den Vorstrecker** ([`lib/email/charter-reminder-template.ts`](../webapp/lib/email/charter-reminder-template.ts)): pro Tranche Soll Vercharterer, Σ Crew-Eingänge bei mir, schon-überwiesen, noch offen. Wird ausgelöst entweder vom 🔔-Button in der Vorstrecker-Zeile oder automatisch vom Cron 3 Tage vor Charterfrist. `lib/email/send-prepayment-reminder.ts` routet zwischen Crew-Pfad und Vorstrecker-Pfad anhand von `personId === advancer_person_id`.
- **Auto-Reminder-Cron** (`/api/cron/prepayment-reminders`, täglich `0 7 * * *` als Coolify Scheduled Task, Dedup über `prepayment_reminder_log` aus Migration 0028): `crew_3d` = innerhalb der letzten 6 Tage vor Charterfrist an offene Crewmitglieder (= 3 Tage vor Crewfrist); `advancer_3d` = innerhalb der letzten 3 Tage vor Charterfrist an den Vorstrecker (Charter-Übersicht). Fenster statt exakter Tagesgleichheit, damit ein verpasster Cron-Tag (Outage, Deploy) keinen Reminder verliert. Pro `(tranche_id, person_id, reminder_type)` höchstens ein Eintrag. **Pending-Awareness:** Crew mit unbestätigter Selbstmeldung (`v_prepayment_pending`) wird übersprungen — sie wartet auf den Vorstrecker. **Advancer-Skip:** keine `advancer_3d`-Mail wenn die Tranche bereits voll an den Vercharterer überwiesen ist. **Reject räumt Dedup-Log:** `rejectSelfPayment` löscht den `crew_3d`-Eintrag der betroffenen Person, sodass eine korrigierte Mahnung folgen kann. Abgelaufene Trips übersprungen.
- **Notice-Mails bei Admin-Aktionen** ([`lib/email/prepayment-notice-template.ts`](../webapp/lib/email/prepayment-notice-template.ts)): wenn `recordPayment` / `confirmSelfPayment` / `rejectSelfPayment` von einer dritten Person (Admin/Co-Skipper) ausgelöst wird, gehen Info-Mails an Crew-Person + Vorstrecker (sofern Actor ≠ Empfänger). Self-Aktionen erzeugen keine Notice. Pendant für Bordkasse-Schulden: bei Admin-Drittaktion bekommen Skipper und Vorstrecker zusätzliche Observer-Mails.
- **Einheitliches Mail-Design** ([`lib/email/mail-shell.ts`](../webapp/lib/email/mail-shell.ts)): Logo-PNG-Header + Card-Wrapper + Footer als gemeinsame Shell. Alle sechs Templates (settlement, debt-settled, prepayment-reminder, charter-reminder, payment-pending, prepayment-notice) nutzen sie.

## Phasen-Plan (historisch)

Beide Phasen sind abgeschlossen — die Liste bleibt als Referenz drin, falls jemand den ursprünglichen Schnitt nachvollziehen will.

### Phase 1 — Kern (Migrationen 0023 + 0024) — erledigt
- DB-Migration (4 Tabellen + `transactions.tranche_id` + `advancer_person_id`)
- Skipper-Wizard zwei Schritte (Aufteilung + Tranchen, inkl. Kojen-Editor + CrewQuickAdd)
- Anzahlungs-Matrix mit Statussymbolen + Weg-1-Modal
- Erweiterung der Gutschrift-Maske (Weg 2) und Buchungs-Maske um Tranche-Dropdown
- Bilanz-Erweiterung (drei Blöcke) + Bordkasse-Pool-Trennung
- Crew-Sicht (Read-Only Status für eigene Zeile)
- Mail-Versand 🔔 + WhatsApp-Modal 💬 (pro Person + Sammel)
- Crew-Wechsel-Workflow + Auto-Merge bei Ghost→Real-E-Mail-Kollision
- Crew-Anlage ohne E-Mail
- Vitest-Tests gegen Test-Szenario „Yachtanzahlung mit Kojen, 2 Tranchen, 1 Crew-Wechsel"

### Phase 2 — Selbstmeldung (Migration 0025) — erledigt
- Crew-Button „Ich habe gezahlt" → `transactions.confirmed_at = NULL` (= pending)
- Vorstrecker-Bestätigungs-Workflow (✓/✗ in der Matrix)
- Mail-Notifications an den Vorstrecker bei Selbstmeldung
- Statussymbol ⏳ + Pending-Banner

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

**Bilanz nach Törnende (vor Bordkasse-Settlement):**
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
