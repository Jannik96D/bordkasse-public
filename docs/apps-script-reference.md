# Apps Script Referenz

Vollständiges Mapping aller Zellkoordinaten und Funktionen für das Apps Script v11 (kompatibel mit xlsx-Layout v10).

## Zellkoordinaten (Konstanten am Anfang des Scripts)

### Eingabe-Tab (`E`) — nur noch Ausgaben

```javascript
const E = {
  SHEET:        "Eingabe",
  DATUM:        "B6",
  BESCHREIBUNG: "B9",
  KATEGORIE:    "B12",
  BEZAHLT_VON:  "B15",
  BETRAG:       "B18",
  ALKOHOL:      "B21",
  AUFTEILUNG:   "B25",

  // Anwesenheits-Checkboxen für "Individuell"
  DABEI_START_ROW: 31,    // Erste Person-Zeile
  DABEI_COL:       3,     // Spalte C (war D in v9)
  DABEI_COUNT:     12,    // P1 bis P12

  // Dynamisch ein-/ausblendbarer Bereich (nur noch Individuell)
  INDIVIDUELL_FIRST_ROW: 28,
  INDIVIDUELL_LAST_ROW:  42,
};
```

### Gutschrift-Tab (`G`) — eigenständige Maske seit v9

```javascript
const G = {
  SHEET:        "Gutschrift",
  DATUM:        "B6",
  BESCHREIBUNG: "B9",   // optional
  BETRAG:       "B12",
  GUT_VON:      "B16",  // Dropdown Besatzung!B11:B22
  GUT_AN:       "B19",  // Dropdown Besatzung!K11:K23 (inkl. "Alle")
};
```

### Transaktionen-Tab (`TX`)

```javascript
const TX = {
  SHEET:    "Transaktionen",
  START:    4,      // Erste Datenzeile
  MAX:      203,    // Letzte erlaubte Zeile (200 Einträge)
  
  // Spalten
  DATUM:    2,      // B
  TYP:      3,      // C
  DESC:     4,      // D
  KAT:      5,      // E
  PAID:     6,      // F (Bezahlt von)
  BETRAG:   7,      // G
  ALKOHOL:  8,      // H
  SPLIT:    9,      // I (Aufteilung)
  DABEI_S:  10,     // J = P1 anwesend, K = P2, ... U = P12
  GUT_VON:  34,     // AH
  GUT_AN:   35,     // AI
};
```

### Besatzung-Tab (`B`)

```javascript
const B = {
  SHEET:      "Besatzung",
  NAME_COL:   2,    // Spalte B = Namen
  NAME_START: 11,   // Zeile 11 = P1
  N:          12,   // Maximale Crew-Größe
};
```

### Schulden-Tab (`S`)

```javascript
const S = {
  SHEET:      "Schulden",
  DATA_START: 8,    // Erste Datenzeile
  DATA_MAX:   27,   // Bis zu 20 Überweisungen
  TIMESTAMP:  31,   // Zeile für "Letzte Aktualisierung"
};
```

## Funktionsübersicht

### Hauptfunktionen (User-Interaktion)

| Funktion | Was sie macht | Wie aufgerufen |
|---|---|---|
| `transaktionSpeichern()` | Liest Eingabe-Tab, validiert, schreibt Ausgabe in Transaktionen, leert Maske, berechnet Schulden | Menü, Button |
| `gutschriftSpeichern()` | Liest Gutschrift-Tab, validiert, schreibt Gutschrift in Transaktionen, leert Maske, berechnet Schulden | Menü, Button |
| `eingabeLeeren()` | Setzt alle Eingabe-Felder zurück (Datum = heute) | Menü |
| `gutschriftLeeren()` | Setzt alle Gutschrift-Felder zurück (Datum = heute) | Menü |
| `schuldenBerechnen()` | Greedy-Algorithmus, befüllt Schulden-Tab | Menü, am Ende der Speichern-Funktionen |
| `neuenToernStarten()` | Leert Transaktionen (Daten-Spalten, Calc-Formeln bleiben), Schulden, Crew-Daten in Besatzung, Törn-Datum, Eingabe + Gutschrift. Mit Bestätigungs-Dialog | Menü |

### Helper-Funktionen (intern, mit `_` Suffix)

| Funktion | Was sie macht |
|---|---|
| `eingabeMaskeLeeren_(wsEin)` | Felder auf Default zurücksetzen (Datum=heute, Aufteilung="Gleichmäßig"), Anwesenheit-Checkboxen leeren, Individuell-Toggle aufrufen |
| `gutschriftMaskeLeeren_(wsGut)` | Felder im Gutschrift-Tab leeren, Datum auf heute setzen |
| `freieZeileFinden_(wsTx)` | Nächste freie Zeile in Transaktionen (DESC + GUT_VON beide leer); -1 wenn voll |
| `schuldenBerechnen_(ss)` | Implementierung des Greedy-Algorithmus, schreibt in Schulden-Tab |
| `toggleIndividuellBlock_(wsEin)` | Zeilen 28–42 ein-/ausblenden je nach Aufteilung B25; ruft bei "Individuell" `refreshDabeiZeilen_` auf |
| `refreshDabeiZeilen_(wsEin, wsBes)` | Im aufgeklappten Block: Crew-Zeilen ohne Namen in Besatzung B11:B22 ausblenden, mit Namen einblenden |
| `alertMissing_(ui, ws, cell, msg)` | Validierungsfehler anzeigen + Cursor in fehlerhaftes Feld |

### Auto-Trigger

| Trigger | Funktion | Auslöser |
|---|---|---|
| `onOpen()` | Menü erstellen, Individuell-Block initialisieren, Datum-Felder auf heute setzen wenn leer | Datei wird geöffnet |
| `onEdit(e)` | Eingabe!B25 (Aufteilung) → `toggleIndividuellBlock_` · Besatzung!B11:B22 (Crew-Namen) → `refreshDabeiZeilen_` (nur wenn Aufteilung aktuell "Individuell") | Beliebige Zellenänderung |

### Button-Wrapper

```javascript
function buttonSpeichern()           { transaktionSpeichern(); }
function buttonGutschriftSpeichern() { gutschriftSpeichern(); }
function buttonLeeren()              { eingabeLeeren(); }
function buttonGutschriftLeeren()    { gutschriftLeeren(); }
function buttonSchuldenBerechnen()   { schuldenBerechnen(); }
```

Diese werden im Sheet als gezeichnete Schaltflächen mit Skript-Zuweisung verwendet.

## Hauptablauf `transaktionSpeichern` (Ausgaben)

```
1. Werte aus Eingabe-Tab lesen (datum, beschreibung, kategorie, bezahltVon, betrag, alkohol, aufteilung)
2. Anwesenheits-Checkboxen P1–P12 lesen (dabei[0..11])
3. Validieren: beschreibung, betrag, bezahltVon, alkohol ≤ betrag
4. freieZeileFinden_(wsTx) — nächste Zeile mit leerem DESC und leerem GUT_VON
5. Datum bestimmen (leer → heute)
6. In Transaktionen-Zeile schreiben: TYP="Ausgabe", alle Felder + Number Formats
7. Bei "Individuell" Aufteilung: x-Marken in Spalten J–U eintragen
8. eingabeMaskeLeeren_(wsEin) — Datum wird auf heute gesetzt
9. schuldenBerechnen_(ss) aufrufen
10. Erfolgs-Dialog anzeigen
11. Cursor auf Datum-Feld setzen für Folgeeingabe
```

## Hauptablauf `gutschriftSpeichern`

```
1. Werte aus Gutschrift-Tab lesen (datum, beschreibung, betrag, gutVon, gutAn)
2. Validieren: gutVon, gutAn (verschieden), betrag
3. freieZeileFinden_(wsTx)
4. Datum bestimmen (leer → heute)
5. In Transaktionen-Zeile schreiben: TYP="Gutschrift",
   DESC = beschreibung || "Gutschrift", BETRAG, GUT_VON (Spalte AH), GUT_AN (Spalte AI)
6. gutschriftMaskeLeeren_(wsGut) — Datum wird auf heute gesetzt
7. schuldenBerechnen_(ss) aufrufen
8. Erfolgs-Dialog anzeigen
9. Cursor auf Datum-Feld setzen für Folgeeingabe
```

## Hauptablauf `schuldenBerechnen_`

```
1. Bilanz-Sheet auslesen (A4:F15)
2. Personen extrahieren (mit Name + Saldo, gerundet auf 2 Nachkommastellen)
3. Trennen in:
   - schuldner (Saldo < -0.005), als positive "offen"-Beträge, sortiert absteigend
   - glaeubiger (Saldo > 0.005), sortiert absteigend
4. Greedy-Loop:
   while si < schuldner.length && gi < glaeubiger.length:
     betrag = min(schuldner[si].offen, glaeubiger[gi].offen)
     transaktionen.push({ von, an, betrag })
     beide.offen -= betrag
     wenn schuldner.offen < 0.005: si++
     wenn glaeubiger.offen < 0.005: gi++
5. Schulden-Sheet leeren (Datenbereich A8:E27)
6. Transaktionen schreiben (max. 20)
7. Timestamp in Zeile 31 setzen
```

## Toggle-Logik

### `toggleIndividuellBlock_`

```javascript
if (aufteilung === "Individuell") {
  showRows(28, 15);              // 28 + 15 - 1 = 42 — kompletter Block sichtbar
  refreshDabeiZeilen_(...)       // dann Crew-Zeilen ohne Namen wieder ausblenden
} else {
  hideRows(28, 15);
  // Alle Checkboxen leeren beim Ausblenden (Spalte C seit v10)
  for (let i = 0; i < 12; i++) {
    setRange(31 + i, 3).setValue("");
  }
}
```

### `refreshDabeiZeilen_`

```javascript
for (let i = 0; i < 12; i++) {
  const name = wsBes.getRange(11 + i, 2).getValue();   // Besatzung B11..B22
  const row  = 31 + i;                                 // Eingabe-Zeile
  if (!name || name.toString().trim() === "") {
    wsEin.hideRows(row);
    wsEin.getRange(row, 3).setValue("");               // Checkbox in C zurücksetzen
  } else {
    wsEin.showRows(row);
  }
}
```

Wird aufgerufen aus `toggleIndividuellBlock_` (wenn Block aufgeklappt wird) und aus `onEdit` wenn ein Crew-Name in Besatzung B11:B22 geändert wird (und Aufteilung gerade auf "Individuell" steht).

Den `toggleGutschriftBlock_` aus v8 gibt es nicht mehr — Gutschrift hat seit v9 einen eigenen Tab.

## Validierungsmuster

```javascript
function alertMissing_(ui, ws, cell, msg) {
  ui.alert("⚠️ Eingabe fehlt", msg, ui.ButtonSet.OK);
  ws.getRange(cell).activate();   // Cursor auf das fehlerhafte Feld
}

// Verwendung (Ausgabe):
if (!beschreibung) {
  return alertMissing_(ui, wsEin, E.BESCHREIBUNG, "Bitte eine Beschreibung eingeben.");
}

// Verwendung (Gutschrift):
if (!gutVon || !gutAn) {
  return alertMissing_(ui, wsGut, G.GUT_VON, "Bitte 'Zahlt (Von)' und 'Empfängt (An)' ausfüllen.");
}
```

Wichtig: `return` damit die Funktion abbricht.

## Datum-Autofill

Seit v9 setzen `eingabeMaskeLeeren_`, `gutschriftMaskeLeeren_` und `onOpen` (für leere Felder) das Datum automatisch auf heute:

```javascript
ws.getRange(DATUM).setValue(new Date()).setNumberFormat("DD.MM.YYYY");
```

User kann das Datum überschreiben — nur Default ist heute.

## Berechtigungen

Beim ersten Aufruf von `transaktionSpeichern` oder `onEdit` fragt Google nach folgenden Scopes:

- `https://www.googleapis.com/auth/spreadsheets.currentonly` — die aktuelle Tabelle lesen/schreiben
- `https://www.googleapis.com/auth/script.container.ui` — UI-Dialoge (Alerts) anzeigen

User muss "Erweitert → Zu Bordkasse Makro (unsicher)" durchklicken (Standard bei privaten Scripts).

## Versionsverwaltung

Im Header der `.js`-Datei:

```javascript
// BORDKASSE — Apps Script v11
// Kompatibel mit xlsx-Layout v10 (keine Layout-Änderungen).
//
// NEU in v11:
// - Menüpunkt "🆕 Neuen Törn starten" (neuenToernStarten)
//
// NEU in v10:
// - Anwesenheits-Checkbox jetzt in Spalte C (vorher D)
// - Leere Crew-Slots werden im Individuell-Block automatisch ausgeblendet
```

Bei Änderungen:
1. Versionsnummer hochziehen (`v11` → `v12`)
2. Changelog-Eintrag im Header
3. Wenn nur das Script geändert wird (keine Layout-/Zellkoordinaten-Änderungen): xlsx unverändert lassen, Header-Kommentar `Kompatibel mit xlsx-Layout vN` aktualisieren
4. Wenn Zellkoordinaten sich ändern: Migrations-Skript in `scripts/` schreiben (Vorlage: `scripts/migrate_v9_to_v10.py`)

## Limitierungen Apps Script

| Limit | Bedeutung |
|---|---|
| Ausführungszeit max. 6 min | Bei vielen Transaktionen evtl. relevant — aktuell nicht problematisch |
| `onEdit` läuft synchron | Verzögert Cursor um ~200ms — auf Mobile spürbar aber nicht störend |
| Keine Inline-Bibliotheken | Alles muss als einzelne `.js`-Datei eingefügt werden |
| Quote: 90 min total/day für Triggers | Bei normaler Nutzung weit unkritisch |

## Häufige Fehler beim Erweitern

**Fehler:** `TypeError: Cannot read property 'getValue' of null`
**Ursache:** Sheet-Name falsch geschrieben oder existiert nicht.
**Fix:** `getSheetByName()` Rückgabe prüfen.

**Fehler:** Eingabefelder werden geleert, aber neue Zeile in Transaktionen fehlt.
**Ursache:** `nextRow` Logik findet keine freie Zeile, weil falsche Spalte geprüft wird.
**Fix:** `TX.DESC` und `TX.GUT_VON` müssen beide geprüft werden (Ausgabe vs. Gutschrift).

**Fehler:** Schulden-Tab zeigt "00:00:00" als Name.
**Ursache:** Bilanz-Spalte A referenziert leere Besatzungs-Zelle als Datum.
**Fix:** In Bilanz Spalte A `IFERROR(IF(Besatzung!B11="","",Besatzung!B11),"")` verwenden.

**Fehler:** Toggle-Funktion blendet Zeilen aus, aber sie kommen nicht wieder.
**Ursache:** `onEdit` Trigger braucht zwingend Berechtigung — bei automatisch-installiertem Trigger fehlt die.
**Fix:** Einmal manuell `onOpen()` aus dem Editor ausführen, Berechtigung erteilen.

## Migration auf neue Version (Beispiel: v10 → v11)

Wenn strukturelle Änderungen an Tabs/Koordinaten anstehen:

1. Migrations-Skript in `scripts/` anlegen — Vorlagen: `scripts/migrate_v8_to_v9.py` (Tab-Restrukturierung), `scripts/migrate_v9_to_v10.py` (Spalten-/Zell-Verschiebung mit Style-Erhalt)
2. Skript erzeugt parallel `Bordkasse_IJsselmeer2026_vN.xlsx` und `Bordkasse_AppScript_vN.js`,
   originale Vorgängerversion bleibt unangetastet
3. Falls User die xlsx zwischenzeitlich manuell angepasst hat (Spaltenbreiten/Zeilenhöhen): Skript optional mit alternativem Quellpfad aufrufen können — `migrate_v9_to_v10.py` zeigt das Pattern (`sys.argv[1]` Override)
4. Header-Versionsnummer und Changelog im Apps Script updaten
5. In Test-Spreadsheet einfügen, alle 7 Test-Szenarien aus `calculation-rules.md` durchspielen
6. Wenn ok: alte Version nach `assets/sheets-archive/` verschieben, neue als `current` ohne Suffix umbenennen
