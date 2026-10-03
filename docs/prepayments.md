# Anzahlungs-Tranchen — Spec

Modul zur Erfassung, Planung und Nachverfolgung von Anzahlungen, die Crewmitglieder lange **vor** dem Törn an den Skipper oder einen anderen Vorstrecker leisten — typischerweise als Beteiligung an der Yacht-Charter, die der Skipper bereits Monate vor Reisebeginn buchen und (in Tranchen) bezahlen muss.

> **Status: Implementiert** über Migrationen 0023–0028. Phase 1 (Kern) + Phase 2 (Crew-Selbstmeldung) + Auto-Reminder-Cron + Vorstrecker-Konzept + Charter-Reminder-Mail sind live. Diese Spec spiegelt den aktuellen Stand und beschreibt die Mechanik im Detail.

> **Sprachregelung:** „Vorstrecker" ist in dieser Spec der interne Konzept-Name (Code-Identifier `advancer_*`, `requireSkipperAdminOrAdvancer`). In **Endnutzer-Texten (UI/Mail)** wird die Rolle geschlechtsneutral formuliert: Badge „Streckt vor", sonst „die vorstreckende Person" bzw. das Verb „vorstrecken". Analog werden „Schuldner/Gläubiger" im UI als „wer zahlt / wer das Geld bekommt" ausgedrückt.

> **Begriffe seit PR7 („Weitere Zahlungen"):** Intern heißt eine weitere Zahlung weiterhin **`item`** bzw. **„Posten"** (Tabellen `prepayment_items`/`prepayment_item_*`, `item_id`, Funktionen `saveItem` …, dieser Spec-Teil). In **allen Nutzertexten** (UI, Mails, Pushs, /about) gibt es das Wort „Posten" nicht mehr — dort heißt es „Weitere Zahlung(en)" (nur in Überschriften/Navigation/Dialogtiteln; Mails und Pushs nennen die Sache beim Label, z. B. „Flüge: dein Anteil 180,00 € bis 12.10."). Der Test `__tests__/term-consistency.test.ts` scannt `app/` + `lib/` (ohne Kommentare) und schlägt bei „Posten" im Nutzertext fehl. Einheitliche Wörter (`lib/prepayments/payment-words.ts`):
>
> | Konzept | Wort |
> |---|---|
> | Crew meldet eine Einzahlung | „Ich habe gezahlt" (Modal „Einzahlung melden") |
> | Skipper/vorstreckende Person bucht eine Einzahlung der Crew | „Einzahlung erfassen" |
> | vorstreckende Person hat an den Anbieter überwiesen | „Überweisung an Anbieter erfassen" |
> | Rolle des Geldempfängers (Plan UND weitere Zahlung) | Badge „Streckt vor: Name" / „die vorstreckende Person" — „Empfänger/Empfängt" entfällt |
> | Gegenstelle der Karte | „Anbieter" (nie Vercharterer/Charteragentur/Fluggesellschaft; `tripVocab().provider`) |
> | Status einer Meldung | „gemeldet – wartet auf Bestätigung", „bestätigt", „abgelehnt" |
>
> **Eine Kartenstruktur:** Anzahlungsplan („Yachtanzahlung"/„Urlaubsanzahlung" über `tripVocab().prepayment`) und jede weitere Zahlung haben dieselbe Anatomie (`payment-card-parts.tsx`): Kopf (Icon + Titel + Betrag + Frist(en) + Badge „Streckt vor: Name" + Gesamtstatus), zwei Fortschrittsbalken „Von der Crew bezahlt" / „An Anbieter bezahlt", Hinweisblock „Noch an Anbieter zu überweisen" (mit „Überweisung an Anbieter erfassen"; beim Plan zusätzlich aufklappbar die Raten-Aufschlüsselung), Personen-/Ratenliste (beim Plan die unveränderte Matrix) und Aktionsleiste in fester Reihenfolge **Einzahlung erfassen · Crew informieren · Bearbeiten** (· Löschen bei weiteren Zahlungen). „Einzahlung erfassen" in der Leiste öffnet erst die Auswahl „Für wen?" (`RecordPickerModal`, nur Personen mit offenem Betrag) und dann den bestehenden Einzahlungs-Dialog; ein Klick auf eine Zelle/Zeile geht weiter direkt. „Plan bearbeiten"/„Crew informieren" sind aus dem Seitenkopf in die Plan-Karte gewandert.
>
> **Ein Mail-Gerüst** (`lib/email/payment-mail.ts`, `renderPaymentMail`): Betreff „{Was}: dein Anteil {Betrag} bis {Datum}" (ohne Datum „– Frist folgt"; Update „Geändert: …"; Erinnerung „Erinnerung: …"), vorstreckende Person „{Was}: du streckst {Betrag} vor – bis {Datum}", Ereignisse „{Was}: {Betrag} von {Name} – {Status}". Blöcke immer „Dein Anteil · Bis wann · An wen · So geht's" (vorstreckend: „Du streckst vor · Bis wann · An wen · So geht's" plus Übersicht Soll Anbieter / von der Crew bei dir / an Anbieter überwiesen / noch zu überweisen), CTA überall „Zahlungen öffnen", Anrede „Hi {Name}," und dieselbe Fußzeile. Wero-Regel unverändert (ohne Wero-ID keine Wero-Erwähnung). Pushs (`lib/notify/payloads.ts`) analog: Titel nennt die Sache + Betrag, Body die Frist.

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

## Weitere Posten (An-/Abreise) — Datenmodell (Migration 0058)

> Stand: Datenbank (PR3, Migration 0058) + Server-Logik (PR4a, Migration
> 0059, siehe „Posten-Actions" unten) + Oberfläche (PR4b, siehe „Weitere
> Posten — Oberfläche" unten). Ein Posten-Feld im Buchungsformular gibt es
> bewusst (noch) nicht.

Neben der Charter-Anzahlung kann ein Törn beliebig viele **Posten** haben
(typisch Flug/Bahn für die An- und Abreise). Ein Posten ist ein **dritter
Topf** neben Bordkasse und Charter-Pool und funktioniert mechanisch wie die
Charter:

| Rolle | Buchung | Wirkung |
|---|---|---|
| Empfänger (`payee_person_id`) zahlt den Anbieter | Ausgabe mit `item_id`, verteilt gemäß Soll | Empfänger wird Gläubiger in Höhe der Crew-Anteile |
| Crew zahlt dem Empfänger ihren Anteil | Gutschrift mit `item_id` (Selbstmeldung → Bestätigung, `confirmed_at`) | gleicht das aus |
| Eigener Anteil des Empfängers | Selbst-Verrechnung `credit_from = credit_to` mit `item_id` | bilanzneutral |

Ohne die Anbieter-Ausgabe wäre die Gesamtbilanz schief (die Crew stünde als
Gläubiger da). Mit ihr gilt Σ `v_balances` = 0, und sobald alle gezahlt haben,
ist der Posten-Topf je Person 0 (Gesamtbilanz = Bordkasse-Bilanz) — pgTAP
`prepayment_items_test.sql`.

**Tabellen:**

- `prepayment_items` — `id`, `trip_id` (CASCADE), `category_id` (nullable,
  Composite-FK `(category_id, trip_id)` → nur Kategorien desselben Törns,
  beim Löschen der Kategorie `SET NULL (category_id)`), `label`,
  `total_amount > 0`, `due_date` (optional), `payee_person_id` (NOT NULL,
  `ON DELETE RESTRICT`), `split_type` (`gleichmaessig` / `zeitanteilig` /
  `individuell` — Kojen gibt es nur bei der Yacht), `sort_order`.
- `prepayment_item_obligations` — PK `(item_id, person_id)`, `trip_id`
  (Composite-FK `(item_id, trip_id)` → Soll kann nie auf einen Posten eines
  fremden Törns zeigen), `amount ≥ 0`.
- `transactions.item_id` — Composite-FK `(item_id, trip_id)` →
  `prepayment_items(id, trip_id)`, `ON DELETE SET NULL (item_id)`. Anders als
  bei `tranche_id` braucht es deshalb keinen App-Check „gehört der Posten zu
  diesem Törn" für die DB-Integrität (die Rollenprüfung bleibt App-Sache).

**Regeln auf DB-Ebene:**

- `tx_pool_exclusive`: `tranche_id IS NULL OR item_id IS NULL` — eine Buchung
  gehört höchstens einem Sondertopf.
- `tx_credit_self` erlaubt A→A zusätzlich bei `item_id IS NOT NULL`
  (Selbstverrechnung) und bei `deleted_at IS NOT NULL` (soft-gelöschte Zeilen
  wirken nirgends; sonst wäre ein Posten — oder eine Tranche — mit einer
  soft-gelöschten Selbstverrechnung wegen des FK-`SET NULL` nie löschbar).
  Eine Bordkasse-A→A-Gutschrift bleibt verboten, auch das Zurückholen einer
  soft-gelöschten.
- **Lösch-Schutz** (Trigger `pi_guard_delete`): ein Posten mit bestätigten
  Zahlungen (Gutschrift ODER Anbieter-Ausgabe) wirft
  `prepayment_item_has_payments`, mit offener Selbstmeldung
  `prepayment_item_has_pending` (SQLSTATE `P0001`, die Message ist der
  stabile Schlüssel für die App). Sonst kippten die Zeilen per `SET NULL` still
  in die Bordkasse. Soft-gelöschte Zeilen werden entkoppelt. Das Löschen des
  ganzen Törns (CASCADE) ist ausgenommen; der Purge läuft durch den Trigger,
  entkoppelt aber vorher selbst (`item_id = NULL`).
- `tx_item_credit_direct`: eine Posten-Gutschrift braucht einen konkreten
  Empfänger — „An Alle" mit `item_id` wird abgewiesen.
- **Empfänger-Schutz** (Trigger `tx_item_credit_payee`, SECURITY DEFINER):
  eine nicht gelöschte Gutschrift mit `item_id` muss `credit_to =
  payee_person_id` des Postens haben, sonst `prepayment_item_credit_wrong_payee`
  (P0001). Grund: `v_prepayment_item_payments` zählt nach `credit_from` —
  ohne die Regel zählte z. B. eine Selbstverrechnung B→B eines
  Crewmitglieds (tx_credit_self erlaubt A→A bei `item_id`) als „bezahlt".
  Trigger statt View-Join, damit die falsche Zeile gar nicht entsteht (eine
  B→C-Gutschrift mit `item_id` wirkte sonst in `v_balances`, ohne in einem
  Topf als Zahlung zu erscheinen). Feuert bei INSERT und bei UPDATE von
  `type`/`trip_id`/`item_id`/`credit_to`/`deleted_at` — NICHT bei `credit_from`
  (Ghost-Merge). Ausgenommen: `credit_to NULL` (→ `tx_item_credit_direct`,
  der Purge nullt `credit_to` und `item_id` zusammen) und soft-gelöschte Zeilen
  (ein Zurückholen prüft erneut). Der Trigger liest den Posten `FOR SHARE`,
  damit ein gleichzeitiger Empfängerwechsel serialisiert wird.
- **Kein Empfängerwechsel bei hängenden Gutschriften** (Trigger
  `pi_guard_payee_change`): solange eine nicht gelöschte Gutschrift (auch
  eine offene Selbstmeldung) am Posten hängt, wirft ein Update von
  `payee_person_id` `prepayment_item_payee_has_credits` (P0001) — sonst
  zählten die alten Zahlungen (`credit_to` = alter Empfänger) weiter als
  „bezahlt", und die spätere Bestätigung einer Selbstmeldung ändert nur
  `confirmed_at`, ginge also am Empfänger-Trigger vorbei. ⚠️ **PR4:**
  Ghost-Merge/`replaceMember` mit einem Empfänger, der schon Gutschriften
  hat, brauchen eine SQL-Funktion, die `payee_person_id` und `credit_to` in
  EINER Transaktion umhängt und dabei beide Trigger kontrolliert umgeht
  (z. B. transaktionslokales Flag — beide sind IMMEDIATE und blocken jeden
  Einzelschritt, auch innerhalb einer Transaktion) —
  bewusst nicht in 0058, weil das Umhängen fremder Zahlungen eine fachliche
  Entscheidung ist.
- **Sichtbarkeit**: beide Tabellen sind für alle Mitglieder lesbar
  (Transparenz wie Migration 0057), das Posten-Soll zusätzlich für die Person
  selbst nach einem Crew-Wechsel. Schreiben nur über den Service-Role-Client.

**Views:**

- `v_balances_bordkasse_only` filtert zusätzlich `item_id IS NULL` →
  `simplify_debts` / `all_debts_settled` (Schulden-Tab, Purge-Gate) bleiben
  Bordkasse-only, ohne eigene Änderung. `v_balances` bleibt die Gesamtbilanz.
  Außerdem zählen unbestätigte Gutschriften dort jetzt nicht mehr (wie in
  `v_balances` seit 0043) — Gürtel gegen eine bestehende Lücke: löscht
  `saveTranches` eine Tranche mit offener Selbstmeldung, nullt der FK die
  `tranche_id`, und die Meldung zählte bisher als echte Bordkasse-Gutschrift.
  `saveTranches` selbst blockt weiterhin nur bestätigte Zahlungen (offen,
  eigener Fix).
- `v_prepayment_item_payments` (bestätigte Crew-Gutschriften je Posten und
  Person) und `v_prepayment_item_pending` (offene Selbstmeldungen) — analog
  `v_prepayment_payments` / `v_prepayment_pending`, `security_invoker`, kein
  `anon`-Zugriff.

**DSGVO:** `purge_trip_data` nullt im anonymisierenden UPDATE zusätzlich
`item_id` (VOR dem Löschen, Lehre aus 0048) und löscht dann Posten-Soll und
Posten; der Orphan-Cleanup lässt Personen stehen, die in einem anderen Törn
noch Posten-Empfänger sind oder dort ein Posten-Soll haben.
`admin_delete_person_data` (und der Altpfad `delete_my_account`) löschen das
Posten-Soll der Person. Ist die Person **Empfänger eines Postens in einem
laufenden Törn** (`end_date >= heute`, nicht gepurged), lehnen beide mit
`is_active_item_payee` ab — auch ohne jede Buchung (dann greift
`has_active_bookings` nicht). Sonst würde sie anonymisiert und aus
`trip_members` entfernt, und spätere Crew-Gutschriften an sie fielen aus der
mitgliedschaftsgetriebenen `v_balances` (Σ ≠ 0). `deleteMyAccount` zeigt
dafür eine eigene Meldung. Nach Törnende bleibt der Posten mit der
anonymisierten Person als Empfänger stehen (wie `advancer_person_id`), und
die Person bleibt (anonymisiert) Mitglied dieses Törns, auch ohne Buchung —
die Crew zahlt Flüge oft erst nach dem Törn zurück, und diese Gutschriften
müssen in `v_balances` weiter wirken. Der
Datenexport (`exportMyData`) enthält `posten_soll`,
`posten_als_empfaenger` (Posten mit `payee_person_id` = ich) und `item_id`
an jeder Buchung.

**Topf-Ausschluss im App-Code (schon in PR3):** Fortschritts-Checkliste
(`countBordkasseExpenses`), Crewwechsel-Warnung (`countPresenceBlindBookings`)
und die „Törn läuft schon"-Prüfung in `replaceMember` zählen nur
Bordkasse-Buchungen, also jetzt zusätzlich `item_id IS NULL`. `updateCredit`
setzt die Bestätigung einer posten-getaggten Gutschrift bei materieller
Änderung zurück (wie bei Tranchen).

**Erledigt in PR4a** (siehe nächster Abschnitt): Bilanz-Seite, Crewwechsel/
Entfernen/Ghost-Merge, Pending-Pre-Check, Edit-Validierung, Outbox-Replay,
Entscheidung zur Abrechnungsmail. **Weiter offen:** Formularfeld „Posten" (UI erledigt in PR4b),
nachträgliches Zuordnen einer bestehenden Buchung zu einem Posten, Self-Klausel für `prepayment_items`
(Ex-Crew sieht ihr Posten-Soll, aber nicht den Posten). Automatische
Erinnerungen: erledigt in PR5 (Abschnitt „Weitere Posten — Erinnerungen").

**Deploy-Reihenfolge:** Migration 0058 auf Produktion einspielen, BEVOR der
PR auf `main` gemergt wird (Coolify deployt beim Merge sofort) — der
App-Code filtert bereits auf die neue Spalte. Ohne Spalte zählen
Checkliste und Crewwechsel-Warnung still 0, `replaceMember` blockt, und der
Datenexport bricht mit Fehlermeldung ab (statt still ohne Buchungen zu
exportieren). Danach den PostgREST-Schemacache neu laden
(`NOTIFY pgrst, 'reload schema';`), falls kein `pgrst_ddl_watch`-Event-Trigger
existiert.

**Vorab-Prüfung (lesend, vor dem Einspielen):**

```sql
select trip_id, count(*) from transactions
 where type = 'credit' and confirmed_at is null
   and tranche_id is null and deleted_at is null
 group by 1;
```

`v_balances_bordkasse_only` zählt unbestätigte Gutschriften ab 0058 nicht
mehr. Liefert die Abfrage Zeilen (verwaiste Selbstmeldungen, deren Tranche
gelöscht wurde), ändert sich für diese Törns sofort die Bordkasse-Bilanz:
`simplify_debts` liefert andere Überweisungen, bereits gesetzte Häkchen in
`settled_debts` (Schlüssel `from/to/amount`) passen evtl. nicht mehr und
erscheinen wieder offen, und `all_debts_settled` (Purge-Gate) kann in beide
Richtungen kippen. Bei abgerechneten Törns die Crew informieren bzw. die
Zeile vorher bewusst bestätigen oder soft-löschen. Leeres Ergebnis = keine
Auswirkung.

## Weitere Posten — Server-Logik (PR4a, Migration 0059)

**Actions** in `webapp/lib/actions/prepayment-items.ts` (alle `(_prev,
formData) → ItemActionState` = `{status:"ok", itemId?, duplicate?} |
{status:"error", message, field?}`, mit `revalidatePath`, UI-fertig):

| Action | Wer | Was |
|---|---|---|
| `saveItem` (JSON in `payload`) | Skipper/Admin | Posten anlegen/ändern, Soll neu verteilen (Delete+Insert wie `savePrepaymentPlan`) |
| `deleteItem` | Skipper/Admin | löschen; blockt bei bestätigten Zahlungen und offenen Selbstmeldungen |
| `recordItemPayment` | Empfänger/Skipper/Admin | Crew → Empfänger, Gutschrift mit `item_id`, sofort bestätigt |
| `submitItemSelfPayment` | Crew (`requireMember`) | „Ich habe gezahlt" → pending (`confirmed_at NULL`) |
| `confirmItemSelfPayment` / `rejectItemSelfPayment` | Empfänger/Skipper/Admin | bestätigen bzw. Soft-Delete |
| `recordItemProviderPayment` | Empfänger/Skipper/Admin | Empfänger → Anbieter, Ausgabe mit `item_id`, `per_person` = Soll |

**Regeln:**

- **Rolle** `requireSkipperAdminOrItemPayee(itemId)` (`lib/auth/authz.ts`):
  Empfänger des Postens (solange er noch Crew ist), Skipper/Co-Skipper oder
  Admin — bewusst NICHT der Vorstrecker der Charteranzahlung. Liefert
  `tripId` des Postens; jede Action vergleicht ihn mit dem `trip_id` des
  Formulars (IDOR). Dazu `itemBelongsToTrip` (`lib/auth/cross-trip.ts`,
  fail-closed), `personsBelongToTrip`, `.eq("trip_id")` auf jedem Write,
  `assertTripNotArchived`.
- **Empfänger und Zahler kommen nie aus dem Formular:** `credit_to` und
  `paid_by` = `payee_person_id` des Postens, `credit_from` der Selbstmeldung =
  eingeloggte Person.
- **Soll** (`lib/calc/prepayment-item-shares.ts:calculateItemObligations`):
  gleichmäßig/zeitanteilig per Largest-Remainder über `calculateObligations`
  (Σ = Summe auf den Cent), individuell = Einzelbeträge, deren Summe der
  Posten-Summe **exakt** entsprechen muss (kein zweiter Topf für eine
  Differenz; bewusst keine automatische Ableitung, Lehre aus 0056).
- **Anbieter-Zahlung als `per_person` = Soll** (Review-Fund Bilanz): equal/
  time_proportional verteilten über ALLE `trip_members` — ein Mitglied ohne
  Posten-Soll zahlte dann fremde Flüge mit. Mit `per_person` ist die
  Gesamtbilanz jeder Person 0, sobald alle ihr Soll gezahlt haben.
  Teilzahlungen werden **kumulativ** verteilt (`allocateItemProviderShares`),
  damit die Rundungs-Cents nicht jedes Mal bei derselben Person landen;
  Σ Anbieter-Zahlungen ≤ Posten-Summe (ein Rest hätte keine Gegenseite).
- **Soll gesperrt nach Anbieter-Zahlung:** sobald eine Anbieter-Zahlung
  existiert, blockt `saveItem` jede Änderung von Betrag, Aufteilung oder
  Einzelbeträgen (und den Empfängerwechsel); Bezeichnung/Kategorie/Fälligkeit
  bleiben änderbar, und das gespeicherte Soll wird dabei NICHT aus der
  inzwischen evtl. geänderten Crew neu berechnet (Grill-Fund: sonst sperrte
  schon ein neues Crewmitglied jede Umbenennung). Ausweg: Anbieter-Zahlung
  löschen, Posten ändern, neu erfassen. (Gewählt statt „nachziehen", weil
  Nachziehen fremde Buchungen in mehreren Schreibschritten ohne echte
  Transaktion umschriebe.)
- **Nachkontrollen gegen parallele Requests** (keine Transaktion über den
  Service-Role-Client): `recordItemProviderPayment` prüft nach dem Schreiben
  erneut Σ Anbieter-Zahlungen ≤ Summe und ob sich das Soll inzwischen
  geändert hat — sonst Rollback dieser Zahlung; `saveItem` rollt zurück, wenn
  während des Neuverteilens eine Anbieter-Zahlung entstand. Scheitert ein
  Rollback selbst, sagt die Meldung das.
- **Kein `:overflow`** bei `recordItemPayment`: ein Posten hat keine zweite
  Tranche; eine Überzahlung bleibt im Topf („überzahlt"), der einzige Insert
  ist über `idempotency_key` dedupliziert.
- **Idempotenz:** alle Inserts tragen optional `idempotency_key` (UNIQUE aus
  0005) → Retry liefert `{status:"ok", duplicate:true}`. `saveItem` nimmt
  eine client-generierte `id`, weist aber jede ID ab, die einem Posten eines
  anderen Törns gehört (Klasse Fund F1).
- **Teilfehler:** `saveItem` rollt Posten/Soll kompensierend zurück (auch wenn
  der Empfängerwechsel als letzter Schritt scheitert),
  `recordItemProviderPayment` löscht die Ausgabe, wenn die Anteile nicht
  geschrieben werden konnten (Muster `createExpense`).
- **Audit ohne Klartext:** keine Bezeichnung, keine Notiz, nur IDs/Beträge.
- **Kein Mail/Push aus den Actions** — die automatischen Erinnerungen kommen
  seit PR5 aus dem Cron (Abschnitt „Weitere Posten — Erinnerungen");
  `rejectItemSelfPayment` räumt dafür den Dedup-Eintrag der Person.
- `removeMember`, `replaceMember` (Payee-Guard nur klassisch), Abrechnungsmail
  und Empfängerwechsel: siehe „Entscheidungen aus dem Review" unten.

**Empfängerwechsel — `move_item_payee` (Migration 0059):** hängt
`payee_person_id` UND die `credit_to` der Posten-Gutschriften in EINER
Transaktion um. Fachliche Entscheidung: **Altzahlungen wandern zum neuen
Empfänger** (wer gezahlt hat, bleibt „bezahlt"; die beiden Empfänger
gleichen das eingesammelte Geld untereinander aus). Technisch: erst der
Posten (der Trigger `pi_guard_payee_change` akzeptiert dafür ein
transaktionslokales Flag `bordkasse.item_payee_move` = genau diese Posten-ID),
danach die Gutschriften — die passen dann zum neuen Empfänger, der Trigger
`tx_item_credit_payee` muss gar nicht umgangen werden. Verworfen:
`session_replication_role` (schaltet alle Trigger + FKs ab), `DISABLE
TRIGGER` (Owner-Recht, Tabellen-Lock). `SECURITY INVOKER`, EXECUTE nur für
`service_role`, `search_path` gepinnt; prüft am Ende die Invariante selbst.
Genutzt von `saveItem` (nur ohne Zahlungen, siehe H1 unten) und vom
Ghost-Merge.
pgTAP: `supabase/tests/move_item_payee_test.sql`.

**Crew:**

- `replaceMember` lehnt in beiden Modi den **Empfänger** eines Postens ab
  (wie den Vorstrecker). **Modus 1** („hat abgesagt", A verschwindet):
  Posten-Soll, Anteile an Anbieter-Zahlungen und Posten-Gutschriften wandern
  auf B (wie beim Charter-Soll: B übernimmt den Platz und hat A privat
  ausbezahlt) — als letzte Schreibschritte NACH dem finalen
  Buchungsspur-Check, damit ein Abbruch den Posten-Topf nicht halb bei A,
  halb bei B zurücklässt. Eine offene Posten-Selbstmeldung blockt; hat die per
  E-Mail gefundene Person schon ein Posten-Soll in diesem Törn, wird vorab
  abgelehnt. Anteile an Anbieter-Zahlungen zählen dort nicht als
  Buchungsspur (`personHasBookingTrace(…, { excludeItemParticipants: true })`),
  sonst wäre jede Absage nach dem Flugkauf blockiert. **Modus 2** („ist
  abgereist am …", A bleibt Crew): am Posten ändert sich NICHTS — anders als
  ein Charterplatz ist ein Ticket persönlich, A ist damit angereist; B reist
  mit eigenem Ticket an (eigenes Soll bzw. eigener Posten). ⚠️ Abweichung vom
  ursprünglichen Plan („überträgt in Modus 1+2"), Ergebnis des Grill-Reviews.
- `removeMember` blockt bei Empfänger-Rolle und offenem Posten-Soll; eine
  0-€-Sollzeile wird mit entfernt. `personHasBookingTrace` zählt die
  Empfänger-Rolle generell als Spur.
- Ghost-Merge: prüft „Ghost ist Empfänger" und liest sein Posten-Soll VOR
  jedem Schreibschritt (Lesefehler → Abbruch ohne Write). Das generische
  `credit_to`-Umhängen lässt Posten-Gutschriften aus (sonst Trigger); der
  Empfängerwechsel (`move_item_payee`, inkl. dieser Gutschriften) läuft
  unmittelbar NACH dem Umhängen der Mitgliedschaft — so ist bei einem Abbruch
  vorher alles beim Ghost, danach beim echten Konto konsistent, und nie
  gehen Gutschriften an eine Person ohne Mitgliedschaft. Das Posten-Soll wird
  übernommen (sonst verschwände es per CASCADE).

**Buchungs-Edit (`updateExpense`/`updateCredit`):** `item_id` ist dort
**unveränderlich** — weder gelesen noch geschrieben. Begründung: eine
Posten-Ausgabe muss `paid_by` = Empfänger und `per_person` = Soll tragen,
eine Posten-Gutschrift `credit_to` = Empfänger; das garantieren nur die
Posten-Actions. Vorab-Validierung mit klaren Meldungen statt DB-Fehler:
Tranche + Posten (`tx_pool_exclusive`), „An Alle" (`tx_item_credit_direct`),
falscher Empfänger (`tx_item_credit_payee`); bei einer Anbieter-Zahlung sind
nur Beschreibung/Kategorie/Datum änderbar. Der Outbox-Replay übernimmt
bewusst kein `item_id` (wie `tranche_id`, S-1).

**Bilanz/Abrechnung:** die Bilanz-Seite nutzt `v_balances_bordkasse_only`,
sobald es einen Plan ODER Posten gibt, und zeigt einen minimalen
Posten-Block (`getItems` in `lib/queries/prepayment-items.ts`, fail-loud).
Die Abrechnungsmail zeigt seit der zweiten Review-Runde den Bordkasse-Saldo
und Anzahlung/Posten getrennt (M1, unten).

**Entscheidungen aus dem Review zu PR 271 (zweite Runde):**

- **H1 — Empfängerwechsel nur ohne Zahlungen:** `saveItem` verweigert den
  Wechsel, sobald lebende Posten-Gutschriften existieren (bestätigt ODER
  offen, inkl. Selbstverrechnung des Empfängers) oder eine Anbieter-Zahlung
  gebucht ist. Ausweg: Zahlungen löschen bzw. Meldungen ablehnen. Damit
  entsteht nie eine verdeckte Schuld zwischen altem und neuem Empfänger. Die
  einzige Stelle, an der Gutschriften per `move_item_payee` mitwandern, ist
  der Ghost-Merge (gleiche Person). Migration **0060** lässt `move_item_payee`
  zusätzlich scheitern (`prepayment_item_provider_paid_by_other`), wenn eine
  lebende Anbieter-Zahlung existiert, die nicht der neue Empfänger geleistet
  hat (schließt das Race; der Ghost-Merge hängt `paid_by` vorher um).
- **H2 —** der Payee-Guard in `replaceMember` gilt nur im klassischen Pfad;
  in Variante b bleibt A Crew UND Empfänger.
- **M1 — Abrechnungsmail:** Saldo = Bordkasse-Saldo
  (`v_balances_bordkasse_only`, passt zum Zahlungsplan), offene Beträge aus
  Anzahlung und Posten stehen getrennt darunter
  (`lib/calc/settlement-balances.ts`). Ohne Plan/Posten ist der getrennte
  Anteil 0. Die Bilanz-Seite zeigt im Posten-Block je Person Posten-Saldo und
  Gesamtsaldo (Layout seit PR4b).
- **M2 — Soll nur bei Bedarf neu verteilen:** `saveItem` verteilt nur neu bei
  neuem Posten, geändertem Betrag, geänderter Aufteilung, geänderten
  Einzelbeträgen oder mit `redistribute: true`. Umbenennen/Kategorie/
  Fälligkeit lassen das Soll unangetastet — auch ohne Anbieter-Zahlung.
- **M3 — removeMember:** offenes Soll bei gleichmäßig/zeitanteilig ohne
  Anbieter-Zahlung und ohne Zahlung/Meldung der Person wird auf die
  verbleibende Crew neu verteilt (Σ = Summe exakt); sonst wird mit konkretem
  Hinweis geblockt (Anbieter-Zahlung, eigene Zahlung, Einzelbeträge).
  Aufräumen der Sollzeilen ist fail-loud und läuft vor dem Entfernen der
  Mitgliedschaft.
- **M4 — Über-/Unterzahlung:** Zellstatus `open`/`pending`/`underpaid`/
  `paid`/`overpaid`; `getItems` liefert `overpaidTotal`/`underpaidTotal`.
  „Abgeschlossen" heißt jetzt: jede Zelle exakt gedeckt (auch keine
  Überzahlung) UND Anbieter exakt bezahlt.
- **Niedrig:** `idempotency_key` ist bei allen Posten-Zahlungen Pflicht;
  `replaceMember` setzt die Posten-Zeilen auf A zurück, wenn ein späterer
  Schritt (inkl. Entfernen von A) scheitert; der Ghost-Merge ruft
  `move_item_payee` vor jedem Schreibschritt als No-op-Probe auf (fehlt die
  Funktion, bricht er ab, bevor etwas geschrieben ist) und blockt einen
  Ghost, der in einem ANDEREN Törn Empfänger ist; Deadlocks (40P01) melden
  „bitte erneut versuchen"; Bestätigen/Ablehnen und die Posten-Rolle
  antworten Fremden einheitlich „nicht gefunden oder keine Berechtigung"
  (kein Existenz-Leck).

**Delta-Review (letzte Runde):**

- `removeMember` verteilt neu, indem es ERST die neuen Beträge der Rest-Crew
  per Upsert schreibt und DANN nur die Zeile der entfernten Person löscht —
  nie ein Posten ohne Sollzeilen. Verteilt wird nur auf Personen, die für
  diesen Posten schon eine Sollzeile haben (zeitanteilig mit deren Tagen);
  ein Nachrücker ohne Soll bekommt keins. Danach Nachkontrolle auf eine
  inzwischen gebuchte Anbieter-Zahlung; jeder Fehler (auch beim Entfernen
  der Mitgliedschaft) schreibt die alten Beträge zurück. Audit-Eintrag ohne
  Klartext.
- `isItemComplete`: ein Posten ohne Sollzeilen ist NICHT abgeschlossen.
- Bilanz-Seite: der Posten-Saldo je Person kommt aus den Buchungen
  (`getItemPotBalances`: Anbieter-Zahlungen − eigene Anteile + gegebene −
  erhaltene bestätigte Posten-Gutschriften), Σ = 0.
- `getBalances`/`getBordkasseOnlyBalances` werfen bei einem Lesefehler statt
  `[]`; `announceSettlement`/`resendSettlement` brechen ab, wenn die Bilanz
  nicht geladen werden kann oder trotz Crew leer ist — keine
  „Du bist quitt"-Mail an alle.
- `move_item_payee` hat in 0060 den Parameter `p_move_credits` (Default
  FALSE): ohne ihn scheitert der Wechsel an lebenden Posten-Gutschriften
  (gleiche Regel wie H1, jetzt race-frei in SQL); nur der Ghost-Merge ruft
  mit TRUE. Die No-op-Probe des Ghost-Merge beweist damit die Signatur aus
  0060 — aber nicht, dass der spätere echte Wechsel gelingt.

**Bekannte Grenzen:**

- **Pool-Anteil in der Abrechnungsmail:** der getrennt ausgewiesene Betrag
  „laut Bilanz" ist Gesamtbilanz − Bordkasse. Beim Charter-Pool stammt er aus
  der Aufteilung der Charter-AUSGABE (equal/time_proportional über die ganze
  Crew), nicht aus dem Matrix-Soll; beide können abweichen. Die Mail
  formuliert deshalb ohne „du zahlst/bekommst" und verweist auf die
  Anzahlungs-Übersicht.
- **replaceMember (L3):** scheitert das Entfernen von A und zusätzlich das
  Zurücksetzen der Posten-Zeilen, bleibt ein gemischter Zustand (Teile bei
  A, Teile bei B); die Meldung sagt das ausdrücklich.
- **UI:** das „überzahlt"-Badge je Person ist seit PR4b umgesetzt.

**Bekannte Grenze (L2):** zwei gleichzeitig gebuchte Teil-Anbieterzahlungen
können je nach Reihenfolge um Rundungs-Cents von der kumulativen Verteilung
abweichen; ihre jeweilige Summe stimmt, und zusammen überschreiten sie den
Deckel nicht (Nachkontrolle). Ein echter Lock bräuchte eine SQL-Funktion für
die Anbieter-Zahlung — bewusst nicht gebaut.

**Deploy-Reihenfolge:** 0058 ist vorhanden → **0059 und 0060** VOR dem
App-Merge auf Produktion einspielen, danach `NOTIFY pgrst, 'reload schema';`.

## Weitere Posten — Oberfläche (PR4b)

**Wo:** Sektion „Weitere Zahlungen" (intern: Posten) unter der Plan-Karte auf `/trips/[id]/prepayments`
(`items-section.tsx`). Sie funktioniert auch **ohne Anzahlungsplan** (eigener
Posten-Törn ohne Charter); die Seite zeigt dann die Karte „Noch kein
Anzahlungsplan" plus die Posten. Einstieg: Anzahlungen-Tab (erscheint über
`getPrepaymentNavState` jetzt auch wegen Posten, Regel `itemsNavRelevant`:
Skipper/Admin = irgendein Posten nicht abgeschlossen, Empfänger = eigener
Posten nicht abgeschlossen, Crew = eigener Anteil offen/gemeldet) und Settings
→ „Anzahlungsplan" → „Weitere Zahlungen verwalten".

**Rollensicht:**

| Wer | Sicht | Darf |
|---|---|---|
| Skipper/Co-Skipper/Admin | Vollkarte aller Posten | anlegen, bearbeiten, löschen, Zahlungen erfassen, Meldungen bestätigen/ablehnen, Anbieter-Zahlung erfassen |
| Empfänger des Postens | Vollkarte dieses Postens | Zahlungen erfassen, Meldungen bestätigen/ablehnen, Anbieter-Zahlung erfassen (kein Bearbeiten/Löschen) |
| übrige Crew | nur die eigene Zeile („Dein Soll / Bezahlt / Offen") | „Ich habe gezahlt" melden |

Der **Vorstrecker der Charteranzahlung** hat am Posten KEINE Rechte (nur wenn
er zugleich Empfänger/Skipper ist) — so verlangen es die Actions. Die Sicht
blendet nur aus, was der Server ohnehin ablehnt. Archivierte Törns: alle
Schreibknöpfe weg, Hinweis „schreibgeschützt".

**Karte:** Kategorie-Icon + Bezeichnung + Betrag, Kategorie-Name, Fälligkeit,
Badge „Empfängt: X", Gesamtstatus (Symbol + Text: Abgeschlossen / Zahlungen
offen / Anbieter noch nicht bezahlt / Überzahlt — Rückzahlung klären), zwei
Fortschrittsbalken (`role="progressbar"`: „Von der Gruppe an X bezahlt" und
„An den Anbieter bezahlt"), Hinweis bei Überzahlung (`overpaidTotal`) bzw.
Rest bei der Gruppe (`underpaidTotal`), Block „Noch an Anbieter zu überweisen"
(Pendant `CharterReminderBanner`: Betrag + `providerDueInfo` = überfällig seit
N Tagen / in N Tagen fällig / fällig am …) mit Button „Zahlung an Anbieter
erfassen", Pending-Banner mit ✓/✗, je Person eine Zeile. Der Posten ist
„Abgeschlossen", wenn `getItems().complete` (jede Zelle exakt gedeckt UND
Anbieter exakt bezahlt).

**Statussymbole** (`ITEM_STATUS_META`, immer Symbol UND Text, Symbol
`aria-hidden`): ○ offen · ⏳ gemeldet, wartet auf Bestätigung · ◐ teilweise
bezahlt · ✓ bezahlt · + überzahlt. Die Zeilen sind 44-px-Buttons (nur bei
Soll > 0 und Schreibrecht) mit vollem Kontext-`aria-label` („Ben, Flüge:
teilweise bezahlt, 40,00 € von 100,00 € bezahlt, 60,00 € offen. Zahlung
erfassen").

**Formular** (`item-form-modal.tsx` → `saveItem`, JSON im Feld `payload`):
Kategorie (`CategorySelect`; Vorbelegung „An-/Abreise" falls vorhanden, bei
Bestandstörns leer), Bezeichnung, Betrag (Rechenfeld: `evalItemAmount` =
`parseAmountDe` für „3.700,00" dann `safeMathEval` für „1200 - 150,50"),
Fälligkeit (optional), Empfänger (Default Trip-Skipper), Aufteilung
Gleichmäßig / Zeitanteilig / Individuell (**kein „An Bord"** — Posten haben kein
Buchungsdatum; steht als Hinweis im Formular). Individuell: Betrag je Person mit
Live-Differenz (`role="status"`), die Summe muss exakt aufgehen. „Soll neu
verteilen" (`redistribute`) nur beim Bearbeiten und nicht bei „individuell",
mit Erklärung (sinnvoll nach Crewwechsel). **Gesperrte Änderungen** werden als
Hinweis mit disabled Feldern gezeigt (`itemLocks`, spiegelt die Server-Regeln):
Betrag/Aufteilung nach Anbieter-Zahlung, Empfängerwechsel nach Anbieter-Zahlung
oder lebenden Posten-Gutschriften, Löschen bei bestätigten Zahlungen oder
offener Selbstmeldung. Server-Fehler erscheinen als `role="alert"`, Erfolg als
Toast. Jedes Zahlungs-Modal erzeugt seinen `idempotency_key` einmal pro Mount;
ein Retry meldet „Schon erfasst".

**Bilanz-Seite:** Posten-Block mit Status je Posten (Badge „überzahlt" geht vor
„teilweise"), Zeile „Crew X von Y · Anbieter X von Y", Saldo-Tabelle je Person
(Posten-Saldo aus `getItemPotBalances`, Gesamtsaldo; Vorzeichen + Screenreader-
Text) und Erklärung der Töpfe im Tooltip (nur die vorhandenen).

**Bewusst nicht enthalten:** keine manuelle 🔔-Erinnerung für Posten (die
automatischen Erinnerungen kommen seit PR5 aus dem Cron, der Hinweis in der
Sektion nennt die Zeitpunkte); kein Posten-Feld im Buchungsformular und
kein nachträgliches Zuordnen einer bestehenden Buchung (kein Server-Support,
`item_id` ist im Edit unveränderlich); kein eigener Wizard-Schritt — Posten
werden direkt auf der Anzahlungs-Seite gepflegt.

## Personenliste (PR8)

Anzahlungsplan und weitere Zahlungen zeigen dieselbe **Personenliste**: eine Zeile pro Person mit Status (Symbol + Text), „bezahlt / Soll" und dem Knopf **„Einzahlung erfassen"** (Skipper/vorstreckende Person) bzw. **„Ich habe gezahlt"** (Crew, nur die eigene Zeile). Komponente `app/trips/[id]/prepayments/person-status-list.tsx`, reine Logik `lib/prepayments/person-rows.ts` (Vitest `person-rows.test.ts`, Klick-Test `person-list-interaction.test.tsx` mit happy-dom).

- **Raten (nur Anzahlungsplan):** hat eine Person mehrere Raten, klappt die Zeile auf (`aria-expanded`); jede Rate trägt eigenen Status, Betrag und Knopf. Crew-Sicht startet aufgeklappt. Eine weitere Zahlung hat je Person genau eine Rate → keine Aufklapp-Ebene.
- **Zeilen-Knopf:** genau eine offene Rate → deren Dialog direkt; mehrere offene → „Welche Rate?" (`RecordPickerModal`). Rate-Knopf → Dialog dieser Person + Rate. Es sind dieselben Dialoge/Actions wie zuvor (`recordPayment`, `submitSelfPayment`, Posten-Actions) — nur der Einstieg wechselt von der Matrix-Zelle zur Liste.
- **Personenstatus** aus den Raten: Überzahlung EINER Rate gilt als „überzahlt" und wird nicht gegen eine offene andere verrechnet (Skipper entscheidet über „Überschuss umbuchen"); sonst `itemCellStatus` über Σ Soll / Σ gedeckelt bezahlt / Σ Meldung. „überfällig" nur, solange etwas offen ist.
- **Laufende Selbstmeldung:** Skipper/vorstreckende Person dürfen weiter erfassen (Banner bestätigt/lehnt ab); die Crew sieht für die Rate keinen „Ich habe gezahlt"-Knopf mehr (kein Doppelmelden).
- **Nur eine Ansicht:** die frühere Matrix Person × Rate (und der Umschalter „Matrix-Ansicht") ist entfernt. Beide Karten teilen außerdem Kennzahlenzeile (`PaymentSummaryLine`: „x von y vollständig · n wartet · n überfällig"), Überzahlungs-Hinweis (`OverpaidNote`) und den Banner für gemeldete Einzahlungen mit Bestätigen/Ablehnen (`PendingReportsBanner`, alle in `payment-card-parts.tsx`; Kennzahlen aus `summarizeRows`). Einzige Plan-Besonderheiten: Raten in der Zeile, Aufschlüsselung der Anbieter-Überweisung nach Raten sowie Erinnerung/WhatsApp je Person (für weitere Zahlungen gibt es keine manuelle Erinnerung, nur den Cron); einzige Besonderheit weiterer Zahlungen: „Löschen".
- **Erinnerungs-Glocke (🔔) in beiden Karten** (`ReminderBell` in `payment-card-parts.tsx`): Plan → `sendPrepaymentReminder`, weitere Zahlung → `sendItemReminder` (`lib/actions/prepayment-item-reminder.ts`, Skipper/Admin/vorstreckende Person, Archiv-Guard, nur Mail, kein Dedup-Log). Crew-Person: Mail mit Restbetrag (`item_crew_3d`-Template); vorstreckende Person: Übersicht „noch an den Anbieter zu überweisen" (`item_payee_3d`). Planung rein in `planManualItemReminder` (`lib/prepayments/item-reminders.ts`). **Ohne Frist keine Erinnerung** (Glocke deaktiviert + Action-Fehlermeldung), ebenso bei fehlender E-Mail oder wenn nichts offen ist.
- **Statuslegende** (`StatusLegend`, einklappbar „Was bedeuten die Symbole?", Kurztexte aus `ITEM_STATUS_META`) steht unter der Liste beider Karten (nur Verwalter-Sicht); WhatsApp-Eintrag nur im Plan.
- **Raten:** in der Verwalter-Liste des Plans aufklappbar (A); in der Crew-Ansicht (nur die eigene Zeile) sind die Raten immer sichtbar, ohne Auf-/Zuklappen (`alwaysExpanded`). Weitere Zahlungen haben keine Raten.
- **Löschen:** beide Aktionsleisten sind gleich (Einzahlung erfassen · Crew informieren · Bearbeiten). „Löschen" einer weiteren Zahlung sitzt im Bearbeiten-Dialog (`item-form-modal.tsx`) mit eingebauter Rückfrage („Ja, löschen"); gesperrt (bestätigte Zahlungen/offene Meldung) → Begründung statt Rückfrage. Der Plan hat kein Löschen.

## Weitere Posten — Erinnerungen (PR5, Migration 0061)

Derselbe tägliche Cron wie die Tranchen (`/api/cron/prepayment-reminders`,
Coolify-Task `prepayment-reminders-node`, kein neuer Task) verschickt auch
Erinnerungen für Posten. `prepayment_items.due_date` ist die Frist gegenüber
dem **Anbieter** (Fluggesellschaft/Bahn); die Crew soll — Entscheidung des
Nutzers, exakt wie bei der Charteranzahlung — **3 Tage vorher** gezahlt
haben (`toCrewDueDate` inkl. Clamp). Die Crew-Karte zeigt deshalb „bitte
zahlen bis {Crewfrist}".

| Typ | Ab wann | An wen | Wann NICHT |
|---|---|---|---|
| `item_crew_3d` | 6 Tage vor `due_date` (= 3 Tage vor Crewfrist) | jede Person mit Posten-Soll > 0 und Status offen/teilweise | bezahlt, überzahlt, offene Selbstmeldung (Pending-Awareness), der Empfänger selbst |
| `item_payee_3d` | 3 Tage vor `due_date` | Empfänger des Postens | Σ Anbieter-Zahlungen ≥ Posten-Summe (Pendant Advancer-Skip) |

Für beide gilt: Fenster mit inklusiven Grenzen bis einschließlich zum
Fälligkeitstag (ein ausgefallener Cron-Tag verliert nichts), eine
verstrichene Frist wird nicht mehr beworben; nichts bei Posten ohne
`due_date`, ohne Soll, und in Törns, die vorbei, archiviert oder gepurged
sind. ⚠️ Abweichung vom Tranchen-Teil: der (unveränderte) Tranchen-Code
prüft `trips.archived` NICHT — ein archivierter Törn mit offener Tranche wird
dort weiterhin erinnert, bei Posten nicht.

**Inhalt.** Crew-Mail: Posten (Kategorie: Bezeichnung), offener Betrag (von
Soll), Crewfrist, an wen zahlen, Hinweis „Ich habe gezahlt". Empfänger-Mail:
Soll Anbieter, Crew-Eingänge (nur bestätigte, OHNE die eigene
Selbstverrechnung) von Σ Crew-Soll, bereits an den Anbieter überwiesen, noch
offen — plus Hinweis, falls der eigene Anteil noch nicht als
Selbstverrechnung erfasst ist (der Empfänger bekommt keine Crew-Mail an sich
selbst). Alle frei editierbaren Texte (Bezeichnung, Kategorie, Törnname,
Namen) sind im HTML escaped. Push zusätzlich, additiv nach der Mail
(`itemReminderPush` / `itemPayeeReminderPush`, wirft nie).

**Dedup + Fehler.** `prepayment_item_reminder_log` (UNIQUE `(item_id,
person_id, reminder_type)`, Composite-FK `(item_id, trip_id)` auf den Posten
mit CASCADE, RLS ohne Policy + REVOKE für `anon`/`authenticated`). Send-first
wie bei den Tranchen: Mail, dann Log-Eintrag; 23505 (paralleler Lauf) ist
harmlos, jeder andere Log-Fehler zählt als `failed`. Keine E-Mail hinterlegt
→ `skipped`; Zustellungs- oder Lesefehler → `failed`. Die Cron-Antwort
schlüsselt `tranches` und `items` auf, die Top-Level-Zähler sind die Summe.
`errors[].message` enthält bei Zustellungsfehlern KEINEN SMTP-Rohtext (der
nennt oft die Empfängeradresse, und Coolify speichert die Antwort unter
„Recent executions"), sondern nur „Mail-Zustellung fehlgeschlagen (Code
Antwortcode)"; der Rohtext steht nur im Serverlog. Gilt für beide Teile.

**Fail-soft + Reihenfolge.** Der Tranchen-Teil läuft ZUERST (auch wenn er
scheitert, läuft der Posten-Teil danach; die Antwort ist dann 500 mit
`items`-Zählern). Läuft die App vor der Migration (Tabelle fehlt) oder
scheitert eine Lese-Query des Posten-Teils, zählt das als ein `failed`,
und es geht **keine** Posten-Mail raus (ohne Dedup würde sonst täglich
gemahnt, ohne Zahlungsdaten falsch). Der Posten-Teil wirft nie.

**Zeitbudget.** Der Posten-Teil bricht nach `ITEM_TIME_BUDGET_MS` (150 s)
ab — vor jedem Job und per Wettlauf gegen einen hängenden Versand — und
vermerkt einen `failed`-Eintrag `time_budget`. Nicht verschickte Jobs haben
keinen Log-Eintrag und kommen am nächsten Tag dran (Fenster). Eine bei
Abbruch noch laufende Mail kann trotzdem ankommen und wird dann am nächsten
Tag ein zweites Mal verschickt (lieber doppelt als gar nicht). Zusätzlich
nutzen NUR die Posten-Mails knappe SMTP-Timeouts (`ITEM_MAIL_TIMEOUTS`:
Verbindung/Begrüßung 10 s, Socket 20 s, über den optionalen zweiten
Parameter von `sendMail`); alle anderen Mails behalten die
nodemailer-Defaults.

**Ablehnen.** `rejectItemSelfPayment` löscht den `item_crew_3d`-Eintrag der
Person für diesen Posten (best effort), damit sie im Fenster erneut erinnert
wird (Pendant `rejectSelfPayment`).

**DSGVO.** `purge_trip_data` (Log des Törns, vor dem Posten-Delete),
`admin_delete_person_data` und `delete_my_account` (Log der Person) — in 0061
per `CREATE OR REPLACE` aus 0058 erweitert, Rechte unverändert.

**Zurücksetzen** (alles best effort, ein Fehler bricht die Aktion nicht ab):
- `saveItem` löscht den Log des Postens, wenn sich die Fälligkeit, das Soll
  (Neuverteilung) oder der Empfänger ändert — sonst bliebe es beim Eintrag
  aus dem alten Fenster.
- `removeMember` setzt nach einer Posten-Umverteilung den Log der
  umverteilten Posten zurück (die Rest-Crew schuldet jetzt mehr) und löscht
  die Zeilen der entfernten Person.
- `replaceMember` (klassischer Pfad) räumt den Log von A wie den der
  Tranchen (Pendant F7).
- `deleteTransaction` einer Posten-Gutschrift räumt den `item_crew_3d`-
  Eintrag von `credit_from` für diesen Posten (die Person ist wieder offen).
  Bei Tranchen-Gutschriften bleibt das Altverhalten (kein Aufräumen).

**Auskunft (Art. 15 DSGVO).** Der Log ist personenbezogen (wer wurde wann
erinnert). Er ist nicht Teil des Self-Service-Exports (`exportMyData`, wie
der bestehende `prepayment_reminder_log`); eine Auskunftsanfrage muss ihn
deshalb manuell mit beantworten (`select * from prepayment_item_reminder_log
where person_id = …`). Gelöscht wird er mit Purge und Kontolöschung.

**Bekannte Grenzen.** Ein Ghost-Merge löscht den Ghost
samt Log (CASCADE); die zusammengeführte Person kann im selben Fenster eine
zweite Erinnerung bekommen. Wer nur einen Teil seines Anteils gemeldet hat,
wird nicht erinnert (Pending-Awareness gilt ab der ersten offenen
Selbstmeldung, wie bei den Tranchen). Keine manuelle 🔔-Erinnerung
für Posten.

⚠️ **Deploy:** 0061 vor dem App-Merge auf Produktion einspielen, danach ggf.
`NOTIFY pgrst, 'reload schema';`.

Code: `lib/prepayments/item-reminders.ts` (reine Planung),
`lib/prepayments/item-reminder-cron.ts` (Lauf), `lib/email/send-item-reminder.ts`
+ `item-reminder-template.ts`. Tests: `__tests__/item-reminders.test.ts`,
`__tests__/item-reminder-cron.test.ts`, `prepayment-items-actions.test.ts`
(Reject), pgTAP `prepayment_item_reminder_log_test.sql`.

## Benachrichtigungen für Posten und Anzahlungsplan (PR6, Migration 0062)

Alle Mails laufen über `mail-shell.ts`, Pushes gehen **additiv nach** der Mail
(`docs/push-notifications.md`). Gemeinsame Regeln (rein und getestet in
[`lib/prepayments/notify.ts`](../webapp/lib/prepayments/notify.ts), Versand in
[`lib/email/send-prepayment-notices.ts`](../webapp/lib/email/send-prepayment-notices.ts)):

- **Aktor bekommt nie etwas** über die eigene Aktion; jede Person höchstens eine Mail pro Ereignis.
- **Erst die Aktion, dann die Mail.** Die Versand-Helfer werfen nie; ein Mail-/DB-Fehler beim Versand ändert das Ergebnis der Action nicht (nur Zählung `{sent, failed, skipped}` im Serverlog, ohne Adressen/Namen). Duplikat-Retrys (`idempotency_key`) verschicken nichts.
- **Archivierte Törns** verschicken nichts (die auslösenden Actions sind ohnehin per `assertTripNotArchived` gesperrt).
- **Escaping:** Bezeichnung, Kategorie, Törnname, Notiz, Wero-ID und alle Namen gehen im HTML durch `escapeHtml`.
- **Reise-Typ:** Wortlaut über `tripVocab` (Urlaubskasse/Reise/Reisegruppe bei „Andere Reise").
- **Wero-Regel (Entscheidung Nutzer):** Ohne Wero-ID (leer/nur Whitespace, `normalizeWeroId`) erwähnt eine Mail Wero mit keinem Wort — kein Block, kein Hinweistext. Der Verwendungszweck ist ein neutraler Vorschlag für jede Überweisung und steht deshalb auch ohne Wero da. Posten haben keine eigene Wero-ID: die des Anzahlungsplans gehört der vorstreckenden Person und wird in Posten-Mails **nur** genannt, wenn diese Person auch den Posten empfängt (`weroIdForItem`) — sonst ginge das Geld per Wero an die falsche Person. Gilt auch rückwirkend für die bestehende Erinnerungsmail (`prepayment-reminder-template.ts`).

| Ereignis | Mail an | Variante |
|---|---|---|
| Posten-Selbstmeldung (`submitItemSelfPayment`) | Posten-Empfänger (nicht, wenn er selbst meldet) | „Zahlung gemeldet" — bitte bestätigen (`item-notice-template.ts:renderItemPendingMail`) |
| Bestätigt / abgelehnt (`confirm/rejectItemSelfPayment`) | zahlende Person; zusätzlich der Empfänger, wenn ein Dritter (Skipper/Admin) gehandelt hat | `renderItemNoticeMail` |
| Erfasst (`recordItemPayment`) | zahlende Person + Empfänger, jeweils ohne Aktor; Selbstverrechnung des Empfängers → niemand | `renderItemNoticeMail` |
| Anbieter-Zahlung (`recordItemProviderPayment`) | — | keine Mail |
| **Posten angelegt** (`saveItem`, nur Neuanlage) | alle mit Soll > 0 außer Aktor und Empfänger; Empfänger bekommt eine Übersicht (Summe Anbieter, Frist beim Anbieter, Soll je Person, eigener Anteil) | `announce-templates.ts:renderItemAnnounceCrewMail` / `…PayeeMail` |
| **Anzahlungsplan angelegt** (erstes erfolgreiches `saveTranches`) | alle mit Soll > 0 außer Aktor und vorstreckender Person; diese bekommt die Charter-Übersicht (Rate an den Vercharterer, davon von der Crew, Soll je Person) | `renderPlanAnnounceCrewMail` / `…AdvancerMail` |
| **Crew informieren** (Knopf, manuell) | wie „angelegt", Wortlaut „hat sich geändert" mit den AKTUELLEN Beträgen/Fristen | `isUpdate: true` |

**Bereits Bezahltes und Gemeldetes:** alle Crew-Mails (auch „angelegt") ziehen bestätigte Zahlungen (`v_prepayment_item_payments` / `v_prepayment_payments`) UND offene Selbstmeldungen (`v_prepayment_item_pending` / `v_prepayment_pending`) ab und zeigen „bereits bezahlt / gemeldet, wartet auf Bestätigung / noch offen"; ist nichts mehr offen, entfällt der Zahlungsblock komplett („… bereits vollständig bezahlt" bzw. „… gemeldet und wartet auf die Bestätigung durch X"). Beim Plan werden Zahlungen und Meldungen einer Person **summiert und nach Fälligkeit auf die Raten verteilt** (`allocateCoverage`: erst bestätigt, dann gemeldet, früheste Rate zuerst) — eine Überzahlung einer Rate deckt so die anderen (Raten 50/50, Rate 2 mit 60 und Rate 1 mit 40 bezahlt → nichts offen), Gesamt-Offen wird nie negativ. Sind Zahlungen oder Meldungen nicht lesbar, wird fail-closed NICHTS verschickt.

**Raten-Rundung:** die Raten in den neuen Mails werden per Largest-Remainder (`trancheShares` → `allocateByWeights`) verteilt, Σ Raten = Gesamtanteil exakt. Bewusst NUR in den neuen Mails: Matrix, Crew-Self-View und die bestehende Erinnerungsmail rechnen weiter pro Rate `round2(Soll × % / 100)` (eine zentrale Umstellung hätte angezeigte Sollbeträge und offen/bezahlt-Grenzen bestehender Törns verschoben) — zwischen Mail und Matrix kann eine Rate daher um 1 ct abweichen.

**Empfänger ohne E-Mail (Ghost):** bei einer Posten-Selbstmeldung gehen Skipper und Co-Skipper (ohne Aktor/Empfänger) stellvertretend eine Mail („… an Ben gezahlt … stellvertretend, weil Ben keine E-Mail-Adresse hinterlegt hat"); sie dürfen die Meldung bestätigen. Versand mit knappen SMTP-Timeouts (10 s/15 s), weil er synchron am Ende der Action läuft.

**Inhalt Crew-Mail:** wofür (Kategorie + Bezeichnung bzw. Anzahlungsplan), der eigene Betrag (beim Plan: jede Rate mit Betrag = Soll × % / 100 und Crewfrist), bis wann (**Crewfrist** = Fälligkeit − 3 Tage über `toCrewDueDate` inkl. Clamp; Posten ohne Fälligkeit: „Eine Frist ist noch nicht festgelegt — sie folgt."), an wen (Anzeigename), Zahlungshinweis (Wero nur mit ID), Link auf `/trips/{id}/prepayments`.

**„Genau einmal" für den Anzahlungsplan:** Migration 0062 legt `prepayment_plan.crew_notified_at` an. Nach jedem erfolgreichen `saveTranches` prüft `notifyPlanCreatedOnce` zuerst, (a) dass DIESER Request die ersten Tranchen des Plans angelegt hat (`firstSetup` — vorher gab es keine; schließt auch das Deploy-Fenster „Migration vor App, alter Code legt Tranchen an" aus, in dem das Flag NULL bliebe) und (b) dass die gespeicherten Tranchen zusammen 100 % ergeben (`saveTranches` prüft seine Einzel-Writes nicht — ein teilweise gescheitertes Speichern soll das Flag nicht mit einer unvollständigen Mail verbrauchen), und beansprucht dann atomar `UPDATE … SET crew_notified_at = now() WHERE trip_id = … AND crew_notified_at IS NULL RETURNING`. Nur der Request, der die Zeile trifft, verschickt — Doppelklick, Netzwerk-Retry und jedes spätere Speichern im Wizard verschicken nichts. Bewusst **claim-first** (anders als das Reminder-Log, das „Mail zuerst" schreibt): ein doppelter Versand an die ganze Crew wäre schlimmer als ein verpasster, und für Letzteres gibt es den Knopf. Bestandspläne mit Tranchen wurden per Backfill als „informiert" markiert. Erkennung über eine Spalte statt über Audit-Log/Tranchen-Zählung, weil nur ein atomares Flag das Race zweier paralleler Requests schließt.

**„Genau einmal" für Posten:** ohne Flag — der Create-Zweig von `saveItem` läuft pro Posten nur einmal (ein Retry mit derselben client-generierten ID findet den Posten als `existing` → Update-Pfad, ein paralleler Zweitversuch scheitert am PK).

**Knopf „Crew informieren"** (`lib/actions/prepayment-notify.ts`, UI `app/trips/[id]/prepayments/notify-crew-button.tsx`): für den Plan im Kopf der Anzahlungs-Seite neben „Plan bearbeiten", für Posten in den Admin-Aktionen jeder Posten-Karte. Nur Skipper/Co-Skipper/Admin (`requireSkipperOrAdmin`), Archiv-Guard, Cross-Trip-Check für die Posten-ID. `ConfirmDialog` vor dem Versand, Ergebnis-Toast (`notifyResultMessage`: verschickt / nicht zugestellt / ohne E-Mail-Adresse), Fehler als `role="alert"`. **Weicher Spam-Schutz:** `crew_last_notified_at` (Plan und Posten, gesetzt bei ≥ 1 zugestellter Mail, auch beim automatischen Erstversand) erscheint als „Zuletzt informiert am …" (Europe/Berlin, hydration-sicher) am Knopf und im Dialog — kein harter Block. Änderungen selbst lösen **keine** automatische Mail aus.

**Fail-soft bei fehlender Migration 0062** (App vor Migration): der Claim scheitert → keine „Plan angelegt"-Mail (lieber keine als eine bei jedem Speichern); `getCrewNotifyState` (`lib/queries/crew-notify.ts`, bewusst eine eigene Query statt Spalten in `getPlan`/`getItems`) liefert leer → „zuletzt informiert" fehlt; alle Kernaktionen speichern unverändert.

**Bekannte Grenzen:** der Versand läuft synchron am Ende der Action (`saveItem`, `saveTranches`, Zahlungs-Actions) — bei langsamem Mailserver wartet der Nutzer bis zu den SMTP-Timeouts (10 s/15 s), auch wenn das Speichern schon fertig ist (reine UX, kein Datenproblem; ein asynchroner Versand ist bewusst nicht gebaut). `saveTranches` lehnt einen Lesefehler der bestehenden Tranchen jetzt ab (vorher: alles als Neuanlage), der Wizard sperrt „Fertig stellen" synchron gegen Doppelklick.

Tests: `__tests__/prepayment-notifications.test.ts` (mutationsgeprüft: Empfänger-/Aktor-Ausschluss, Wero mit/ohne/Whitespace, Escaping, Frist mit Puffer/Clamp/ohne Fälligkeit, einmaliger Versand, Knopf-Berechtigung/Archiv, Mailfehler kippt nichts, fehlende Migration, Reise-Typ „other"), pgTAP `prepayment_crew_notified_test.sql`.

## Mail-Templates + WhatsApp-Texte

WhatsApp-Versand läuft immer manuell. Mail-Versand läuft entweder manuell (🔔-Button) oder automatisch via Cron (siehe „Implementierte Erweiterungen" → Auto-Reminder).

Alle Mails nutzen [`lib/email/mail-shell.ts`](../webapp/lib/email/mail-shell.ts) — gemeinsamer Logo-PNG-Header + Card + Footer.

### Erinnerungsmail an Crew (`prepayment-reminder-template.ts`)

Pro Person-Zeile in der Matrix ein Knopf 🔔, plus Auto-Versand vom Cron innerhalb der letzten 3 Tage vor Crew-Fälligkeit. Crew mit pending Selbstmeldung wird automatisch übersprungen. Inhalt:
- Anrede mit Display-Name
- Liste der offenen Tranchen mit Soll-Betrag und Crew-Fälligkeitsdatum (= Charterfrist minus 3 Tage)
- Dynamischer Wero-Hinweis: „Bitte schicke **{Vorstrecker}** per Wero die fällige Anzahlung." mit Wero-ID + Verwendungszweck als Pille. **Kein Klick-Link** — Wero hat keine offene API. Falls keine Wero-ID gepflegt (leer/Whitespace): „Frag {Vorstrecker} nach den Zahlungsdetails." — **ohne** jede Erwähnung von Wero (Wero-Regel, PR6).
- Hint-Block am Mail-Ende erklärt die Wero-Limitation — nur, wenn eine Wero-ID hinterlegt ist
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
- **Mail-Hinweis dynamisch:** „Bitte schicke **{Vorstrecker}** per Wero die fällige Anzahlung." Wero-ID + Verwendungszweck als Pille. Bei fehlender Wero-ID: „Frag {Vorstrecker} nach den Zahlungsdetails." — die Mail erwähnt Wero dann gar nicht (PR6, siehe „Benachrichtigungen"). Posten-Mails nennen die Wero-ID nur, wenn die vorstreckende Person auch den Posten empfängt.
- **WhatsApp-Texte** (`lib/prepayments/whatsapp.ts`) folgen derselben Regel: ohne Wero-ID/-Link entfällt eine Zeile, die nur „Wero: {{wero_link_or_id}}" enthält (Default-Vorlage oder unverändert übernommen), sonst wird der Platzhalter leer ersetzt (früher „—").
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
