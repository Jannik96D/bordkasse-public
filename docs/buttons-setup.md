# Klickbare Buttons in Google Sheets einrichten

Einmalige Einrichtung pro neuer Bordkasse-Datei. Nach dem Setup tippt die Crew nur noch auf "▶ SPEICHERN" und der Eintrag landet in den Transaktionen — kein Menü-Klicken mehr nötig.

> Die xlsx-Vorlage hat die Buttons als gestaltete Zellen (A44 in Eingabe, A22 in Gutschrift). Diese Zellen sind **nicht** klickbar — sie dienen nur als Platzhalter für die Zeichnung, die du jetzt drüber legst.

## Voraussetzung

Apps Script `Bordkasse_AppScript_v10.js` ist bereits eingefügt und gespeichert (Erweiterungen → Apps Script). Tabelle einmal neu geladen.

## Setup-Schritte (pro Button ~1 Minute)

### Schritt 1 — Zeichnung anlegen

1. Tab **Eingabe** öffnen
2. Menü **Einfügen → Zeichnung**
3. In der Zeichnungs-Toolbar das **Rechteck**-Werkzeug wählen (oder die Form mit abgerundeten Ecken)
4. Rechteck zeichnen, ca. 400 × 50 px
5. **Doppelklick** ins Rechteck → Text eingeben: `▶  SPEICHERN`
6. Stil:
   - Füllfarbe: `#114884` (Primärblau)
   - Rand: keiner oder dunkleres Blau
   - Schrift: weiß, fett, ~16pt, zentriert
7. Oben rechts: **Speichern und schließen**

### Schritt 2 — Zeichnung positionieren

Die Zeichnung schwebt jetzt frei. Per Drag & Drop **über die Zelle A44** schieben (über den vorhandenen "▶ SPEICHERN"-Text, der die Position markiert). Größe an die Zellbreite anpassen.

> Tipp: Die Zelle A44 darunter kann leer bleiben — die Zeichnung verdeckt sie. Oder den vorhandenen Text in A44 löschen, wenn dich die Doppellung stört.

### Schritt 3 — Skript zuweisen

1. **Einmal** auf die Zeichnung klicken (sie wird selektiert, dünner Rahmen erscheint)
2. Rechts oben an der Zeichnung erscheint ein **Drei-Punkt-Menü (⋮)** — anklicken
3. **Skript zuweisen…** wählen
4. Im Dialog exakt eintippen: **`buttonSpeichern`**
   - keine Klammern
   - keine Anführungszeichen
   - genaue Schreibweise (case-sensitive)
5. **OK**

### Schritt 4 — Ersten Klick + Berechtigung

Beim allerersten Klick auf einen Skript-Button fragt Google nach Berechtigungen. Einmaliger Durchlauf:

1. "Berechtigung erforderlich" → **Weiter**
2. Google-Konto wählen
3. "Google hat diese App nicht überprüft" → **Erweitert** → **Zu Bordkasse Makro (unsicher)**
4. Berechtigungen prüfen → **Zulassen**

Ab jetzt: ein Tipp = Speichern + Schulden-Neuberechnung + Eingabe-Reset.

## Alle Buttons im Überblick

Setup für alle Buttons identisch — nur Zelle und Funktionsname unterscheiden sich:

| Tab | Zelle (Position) | Beschriftung | Skript-Funktion |
|---|---|---|---|
| Eingabe | A44 | `▶ SPEICHERN` | `buttonSpeichern` |
| Gutschrift | A22 | `▶ GUTSCHRIFT SPEICHERN` | `buttonGutschriftSpeichern` |
| Schulden | freier Bereich oben | `🔄 NEU BERECHNEN` | `buttonSchuldenBerechnen` |
| Eingabe (optional) | rechts neben SPEICHERN | `↺ LEEREN` | `buttonLeeren` |
| Gutschrift (optional) | rechts neben SPEICHERN | `↺ LEEREN` | `buttonGutschriftLeeren` |

Pflicht sind nur die ersten beiden — Schulden-Berechnung läuft nach jedem Speichern automatisch, das Menü reicht für seltene manuelle Aufrufe.

## Buttons in eine neue Bordkasse-Datei übernehmen

Wenn du für einen neuen Törn eine Kopie anlegst:

- Zeichnungen werden mit kopiert ✅
- Skript-Zuweisungen ebenfalls ✅ (sofern das Apps Script in der neuen Datei dieselben Funktionsnamen hat)

→ Buttons müssen also **nicht** für jeden Törn neu eingerichtet werden, nur einmal beim ersten Mal.

## Häufige Probleme

**"Skript nicht gefunden"** beim Klicken
→ Apps Script wurde nicht (oder unter falschem Namen) gespeichert. Prüfen: Erweiterungen → Apps Script → Funktion `buttonSpeichern` muss in der Liste erscheinen.

**Button reagiert nicht auf dem Smartphone**
→ Erst beim **zweiten** Tap reagiert der Klick (erster Tap selektiert die Zeichnung). Ist Google-Sheets-typisch, kein Bug.

**Versehentlich verschoben**
→ Zeichnung anklicken, in Position ziehen. Wenn häufiger ein Problem: Zeichnung anklicken → Drei-Punkt-Menü → "Auf Zelle ausrichten" hilft beim Positionieren, schützt aber nicht vor Verschieben.

**Berechtigung wurde abgelehnt**
→ Im Apps-Script-Editor einmal manuell eine Funktion ausführen (z. B. `onOpen`), dann den Berechtigungs-Dialog erneut durchklicken.
