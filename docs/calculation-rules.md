# Berechnungslogik — Bordkasse

Vollständige Spezifikation aller Aufteilungs- und Berechnungsregeln. Als Referenz für Claude Code wenn Formeln neu gebaut, validiert oder migriert werden müssen.

## Grundbegriffe

| Begriff | Definition |
|---|---|
| **Personentag** | Eine Person × ein Tag an Bord |
| **Bord-Tage einer Person** | Anzahl Tage zwischen "An Bord ab" und "An Bord bis" (inklusive beider Tage) |
| **Zeitanteil** | Bord-Tage einer Person ÷ Summe aller Personentage |
| **Bilanz / Saldo** | Was eine Person mehr bezahlt hat als sie schuldet (positiv = bekommt zurück) |

Wenn "An Bord ab" leer ist, gilt der Törn-Start (Sheets: `Besatzung!B5`; Web-App: `trips.start_date` via `COALESCE` in `v_trip_members_with_days`).
Wenn "An Bord bis" leer ist, gilt das Törn-Ende (Sheets: `Besatzung!B6`; Web-App: `trips.end_date` analog).

**Eingabe vor der Berechnung (nur Web-App):** Betragsfelder akzeptieren Rechen-Ausdrücke (`47,30 - 6,00`, `240,00 / 4`) — ausgewertet via `safeMathEval`. Bei Fremdwährungs-Buchungen wird der eingegebene **Fremdbetrag serverseitig in Euro umgerechnet, bevor** irgendeine Aufteilung greift; alle folgenden Regeln rechnen also unverändert in Euro. Details: [`foreign-currency.md`](foreign-currency.md).

## Die fünf Aufteilungsarten

### 1. Gleichmäßig

Alle in der Besatzungs-Liste eingetragenen Personen zahlen gleich viel — unabhängig davon, ob sie am Tag der Ausgabe an Bord waren.

**Formel pro Person:**
```
Anteil = Betrag / Anzahl_Crewmitglieder
```

**Mit Alkohol:**
```
Nicht_Alk_Teil = (Betrag - Alkohol) / Anzahl_Crewmitglieder
Alk_Teil       = Alkohol / Anzahl_Trinker (nur für Trinker, sonst 0)
Anteil_Person  = Nicht_Alk_Teil + (Alk_Teil wenn Trinker)
```

### 2. An Bord

Nur Personen, die am Datum der Ausgabe laut Besatzungs-Daten an Bord waren.

**Bedingung "an Bord am Datum X":**
```
(Person.AnBordAb <= X) UND (Person.AnBordBis >= X)
```

**Formel pro anwesender Person:**
```
Anteil = Betrag / Anzahl_anwesender_Personen
```

**Mit Alkohol:** wie Gleichmäßig, aber nur unter den anwesenden Personen.

> **Web-App-Guard (Fix C-1):** Ist am gewählten Datum **niemand** an Bord —
> Datum außerhalb des Törns ODER innerhalb, aber vor dem ersten / nach dem
> letzten Anwesenheitsfenster der Crew (z. B. Charter-Übergabetag) — bliebe die
> Ausgabe unallokiert (0 Anteile, Bilanz-Summe ≠ 0). Der Server (`checkOnBoardDate`)
> lehnt „An Bord" dann ab und verweist auf ein Datum im Zeitraum bzw. eine andere
> Aufteilung. Gilt für Anlegen, Bearbeiten und Offline-Replay.

### 3. Zeitanteilig

Proportional zu den Bord-Tagen der Person — auch wenn die Person am Tag der Ausgabe nicht da war (z.B. Yacht-Miete wird über alle Tage des Törns aller Personen verteilt).

**Formel pro Person:**
```
Anteil = Betrag × (Person.BordTage / Summe_aller_BordTage)
```

Beispiel: 9 Personen × 11 Tage + 1 Person × 6 Tage = 105 Personentage.
Bei 210€:
- 11-Tage-Person: 11/105 × 210 = 22,00€
- 6-Tage-Person:  6/105 × 210 = 12,00€

**Mit Alkohol bei Zeitanteilig:**
Etwas tricky. Die Konvention im aktuellen Tool:
- Nicht-Alk-Teil wird zeitanteilig auf alle verteilt
- Alk-Teil wird zeitanteilig nur unter Trinkern verteilt (nach deren Bord-Tagen)

```
Anteil_Person = (Betrag - Alkohol) × (Person.BordTage / Summe_BordTage)
              + Alkohol × (Person.BordTage / Summe_BordTage_der_Trinker)  // nur falls Trinker
```

### 4. Individuell

Nur explizit markierte Personen (Checkbox in Eingabemaske).

**Formel pro markierter Person:**
```
Anteil = Betrag / Anzahl_markierter_Personen
```

**Mit Alkohol:** Aufgeteilt unter den markierten Trinkern.

### 5. Pro Person

Jede Person zahlt einen eigenen, frei eingetragenen Betrag. Gesamtbetrag der
Buchung = Σ Einzelbeträge.

**Formel pro Person:**
```
Anteil = transaction_participants.amount[person]   (0 wenn nicht eingetragen)
```

**Beispiel** (Restaurant-Rechnung):
```
Jannik 12,50 · Stephan 14,50 · Lucas 20,00 · Mama 9,30 — alle anderen 0
→ Gesamtbetrag der Buchung = 56,30€
```

Im Web-Frontend akzeptiert das Eingabefeld auch einfache Rechenausdrücke
(`3 + 17`, `(2 * 4,50)`, Komma oder Punkt als Dezimaltrennzeichen) — siehe
`safeMathEval` in [`lib/utils/math-eval.ts`](../webapp/lib/utils/math-eval.ts).
Der Alkohol-Modifikator entfällt bei "Pro Person".

## Trinkgeld-Verteilung (nur bei „Pro Person")

Feld `tip_amount` (€) auf einer Ausgabe — nur bei `split_type='per_person'`
aktiv. Bei anderen Aufteilungsarten erzwingt die Server-Action
`tip_amount = 0` (UI blendet das Feld aus).

Die eingebende Person wählt zusätzlich die **Verteilungsart**
(`transactions.tip_distribution`):

### `'proportional'` (Default — wer mehr bestellt zahlt anteilig mehr)
```
final_anteil = basis_anteil × (1 + tip_amount / amount)
```

**Beispiel** (60€ Restaurant + 6€ Trinkgeld):
```
Jannik 20€, Ben 30€, Carla 10€ — Trinkgeld 6€ (10%)
→ Jannik 22€, Ben 33€, Carla 11€  ·  Σ = 66€
```

### `'equal'` (gleichmäßig auf alle Beteiligten)
```
final_anteil = basis_anteil + tip_amount / n_beteiligte
```

**Beispiel** (60€ Restaurant + 6€ Trinkgeld, 3 Beteiligte):
```
Jannik 20€, Ben 30€, Carla 10€ — Trinkgeld 6€ → je +2€
→ Jannik 22€, Ben 32€, Carla 12€  ·  Σ = 66€
```

In beiden Fällen gilt: Σ aller Anteile = `amount + tip_amount`. `paid_by`
legt die volle Auslage (inkl. Trinkgeld) aus.

## Gutschrift-Logik

Gutschriften = Geldfluss außerhalb der Bordkasse, der trotzdem die Bilanz beeinflusst.

### Direkte Gutschrift

```
Eingabe: Von=A, An=B, Betrag=X
→ A.Bilanz += X  (A hat gegeben)
→ B.Bilanz -= X  (B hat erhalten)
```

**Saldo-Invariante:** Summe aller Bilanzen bleibt 0.

### "An Alle" Gutschrift

```
Eingabe: Von=A, An="Alle", Betrag=X
→ A.Bilanz += X
→ Für jede Person P ≠ A: P.Bilanz -= X / (N - 1)
```

Wobei N = Anzahl Crewmitglieder.

**Praktischer Anwendungsfall:** Ben zahlt seinen Yacht-Anteil (240€) nachträglich direkt an die Crew, weil Anna die Yacht-Anzahlung allein vorgestreckt hatte. Die Aufteilung der ursprünglichen Yacht-Ausgabe (zeitanteilig auf alle 10) wurde Ben zwar zugerechnet, aber durch die Gutschrift "An Alle" wird sein Anteil quasi neu auf die anderen 9 verteilt.

## Bilanz-Berechnung

Pro Person:

```
Bezahlt              = Σ alle Ausgaben wo Person = "Bezahlt von"
Anteil               = Σ alle Anteile dieser Person aus allen Ausgaben (alle 5 Aufteilungsarten)
Gutschrift_gegeben   = Σ alle Gutschriften wo Person = "Von"
Gutschrift_erhalten  = Σ direkte Gutschriften wo Person = "An"
                      + Σ "An Alle" Gutschriften wo Person ≠ "Von" / (N-1)

Bilanz = Bezahlt + Gutschrift_gegeben - Anteil - Gutschrift_erhalten
```

**Soft-gelöschte Buchungen zählen NICHT.** Buchungen tragen beim Löschen nur ein `deleted_at` (append-only Audit-Trail). Alle Bilanz-relevanten Views filtern `deleted_at IS NULL` — sowohl die Anteils-Quelle `v_transaction_shares` als auch `v_balances` (Bezahlt/Gutschriften) und `v_balances_bordkasse_only`. Eine gelöschte Buchung verschwindet damit vollständig aus Anteil, Bezahlt und Gutschriften. (Migration `0032_balances_filter_deleted` hat das für `v_balances`/`v_transaction_shares` nachgezogen — sie filterten den Soft-Delete zuvor nicht, nur `v_balances_bordkasse_only` tat es bereits.)

## Schulden-Vereinfachung (Greedy-Algorithmus)

Ziel: Minimale Anzahl Überweisungen um alle Salden auszugleichen. Bei N Personen sind maximal N-1 Überweisungen nötig.

```python
def vereinfache_schulden(salden):
    schuldner   = sorted([(name, -saldo) for name, saldo in salden if saldo < -0.005],
                         key=lambda x: -x[1])  # größte Schuld zuerst
    glaeubiger  = sorted([(name, saldo) for name, saldo in salden if saldo > 0.005],
                         key=lambda x: -x[1])  # größtes Guthaben zuerst
    
    transaktionen = []
    si = gi = 0
    while si < len(schuldner) and gi < len(glaeubiger):
        s_name, s_offen = schuldner[si]
        g_name, g_offen = glaeubiger[gi]
        betrag = round(min(s_offen, g_offen), 2)
        
        if betrag > 0:
            transaktionen.append((s_name, g_name, betrag))
        
        s_offen -= betrag
        g_offen -= betrag
        
        if s_offen < 0.005:
            si += 1
        if g_offen < 0.005:
            gi += 1
    
    return transaktionen
```

**Wichtig:** Rundung auf 2 Nachkommastellen verhindert Centfehler.

## Test-Szenarien (Pflicht-Tests)

Setup für alle Szenarien:
- 10 Personen Crew (Anna, Ben, Carla, Diana, Erik, Finn, Greta, Henri, Iris, Jonas)
- Törn 5.–15. April (11 Tage), Finn ab 10.4. (6 Tage)
- Trinker: Carla, Diana, Erik (3 Personen)

### S1: Gleichmäßig

```
Ausgabe: 100€ Lebensmittel von Anna, Aufteilung "Gleichmäßig"
→ Jeder bekommt Anteil 10,00€
→ Anna Saldo: +90€
→ Alle anderen: -10€ je
```

### S2: An Bord

```
Ausgabe: 80€ Restaurant am 08.04. von Anna, "An Bord"
(Finn noch nicht da, 9 Personen anwesend)
→ Anwesende: je 8,89€ (80/9)
→ Finn: 0€
→ Anna Saldo: +71,11€
```

### S3: An Bord + Alkohol

```
Ausgabe: 100€ Restaurant am 12.04., 30€ Alkohol, "An Bord"
(alle 10 anwesend, 3 Trinker)
→ Trinker (Carla/Diana/Erik): 70/10 + 30/3 = 7 + 10 = 17,00€
→ Andere (inkl. Anna): 70/10 + 0 = 7,00€
→ Summe-Check: 3×17 + 7×7 = 51+49 = 100€ ✓
```

### S4: Zeitanteilig

```
Ausgabe: 210€ Sprit von Anna, "Zeitanteilig"
(105 Personentage)
→ 11-Tage-Person: 22,00€ je
→ Finn (6 Tage): 12,00€
→ Summe-Check: 9×22 + 12 = 210€ ✓
```

### S4b: Zeitanteilig + Alkohol

```
Ausgabe: 200€ Restaurant von Anna, 60€ Alkohol, "Zeitanteilig"
(105 Personentage gesamt, 33 Trinker-Tage = 3 Trinker × 11 Tage)
→ Basis 140€ × Tage / 105
  → Full-Trip (11 Tage): 14,67€
  → Finn (6 Tage): 8,00€
→ Alkohol 60€ × Trinker-Tage / 33 (nur Trinker)
  → Carla/Diana/Erik (11 Tage): 20,00€
→ Gesamt:
  → Trinker (Carla/Diana/Erik): 14,67 + 20 = 34,67€
  → Non-Drinker Full-Trip: 14,67€
  → Finn (Non-Drinker, 6 Tage): 8,00€
→ Raw-Summe (unrounded): 200€ ✓
```

### S5: Individuell

```
Ausgabe: 120€ Schwimmwesten von Anna, "Individuell"
Markiert: Ben, Carla, Diana
→ Markierte: je 40,00€
→ Andere: 0€
→ Anna Saldo: +120€ (er hat keinen Anteil)
```

### S6: Gutschrift "An Alle"

```
Vorgeschichte: Anna hat 2400€ Yacht "Zeitanteilig" bezahlt
→ 9 Personen à 11/105 × 2400 = 251,43€
→ Finn: 137,14€
→ Anna Saldo nach Yacht: +2148,57€

Gutschrift: Ben → Alle, 240€ (Ben zahlt seinen Anteil außerhalb)
→ Ben: +240€ (gegeben)
→ Anna & 8 andere: je -240/9 = -26,67€ (erhalten)
→ Ben: 0+240-251,43-0 = -11,43€
→ Anna: 2400+0-251,43-26,67 = 2121,90€
→ Finn: 0+0-137,14-26,67 = -163,81€
→ Andere: 0+0-251,43-26,67 = -278,10€

Saldo-Summe: 2121,90 - 11,43 - 163,81 - 7×278,10 ≈ 0 ✓
```

### S7: Schulden-Algorithmus

```
Eingaben:
1. Anna bezahlt 300€ "Gleichmäßig" → jeder 30€
2. Erik bezahlt 150€ "An Bord" (alle 10 da) → jeder 15€

Bilanz:
- Anna: 300-45 = +255€
- Erik:   150-45 = +105€
- 8 andere: 0-45 = -45€ je

Schulden-Algorithmus erwartet:
- Anna braucht 255€
- Erik braucht 105€
- 8 Schuldner haben je 45€ zu zahlen → Total 360€

Greedy-Ablauf:
1. Schuldner #1 (45€) → Anna: 45€ (Anna offen: 210€)
2. Schuldner #2 (45€) → Anna: 45€ (Anna offen: 165€)
3. Schuldner #3 (45€) → Anna: 45€ (Anna offen: 120€)
4. Schuldner #4 (45€) → Anna: 45€ (Anna offen: 75€)
5. Schuldner #5 (45€) → Anna: 45€ (Anna offen: 30€)
6. Schuldner #6 (45€) → Anna: 30€ (Anna fertig, Schuldner #6 offen: 15€)
                     → Erik: 15€ (Erik offen: 90€)
7. Schuldner #7 (45€) → Erik: 45€ (Erik offen: 45€)
8. Schuldner #8 (45€) → Erik: 45€ (Erik fertig)

Total 9 Überweisungen (statt naiv 16).
```

## Validierungsregeln

Bevor eine Transaktion gespeichert wird:

| Regel | Wann |
|---|---|
| Art muss "Ausgabe" oder "Gutschrift" sein | Immer |
| Beschreibung darf nicht leer sein | Bei Ausgabe |
| Betrag > 0 | Immer |
| "Bezahlt von" muss gesetzt sein | Bei Ausgabe |
| Alkohol-Anteil ≤ Gesamtbetrag | Wenn Alkohol gesetzt |
| "Von" und "An" beide gesetzt | Bei Gutschrift |
| "Von" ≠ "An" | Bei Gutschrift |
| Bei "Individuell": min. 1 Person markiert | Optional, aktuell nicht erzwungen |

## Bekannte Edge Cases

**Ein-Personen-Törn:** Die Berechnung funktioniert, alle Anteile gehen an die eine Person, Bilanz = 0.

**Person mit 0 Bord-Tagen bei "Zeitanteilig":** Anteil = 0, kein Fehler.

**Alle Personen sind Trinker:** Alkohol-Anteil verhält sich wie ohne Alkohol-Markierung.

**Kein Trinker:** Alkohol-Anteil wird auf alle (in der gewählten Aufteilung) verteilt — es gibt niemanden, der ihn übernehmen könnte. Aktuelle Konvention: behandelt als wäre die ganze Crew Trinker (sonst geht der Alk-Anteil ins Leere).

**Leere Crew-Slots (P-Plätze ohne Namen):** werden in allen Berechnungen ignoriert (`COUNTA` schließt sie aus).
