# Tabellenblätter schützen, Eingaben offen lassen

Einmalige Einrichtung pro Bordkasse-Datei. Nach dem Setup kann die Crew nur noch in die vorgesehenen Eingabefelder tippen — Formeln, Transaktionsliste und Berechnungen sind vor versehentlichem Überschreiben geschützt, die Speichern-Buttons funktionieren weiter.

## Hintergrund: Wie Schutz und Buttons zusammenspielen

| Was | Verhalten unter Schutz |
|---|---|
| **Gezeichnete Buttons (Drawings)** | nicht betroffen — bleiben klickbar |
| **Apps Script-Aufrufe via Button** | laufen, aber schreiben nur dort, wo das ausführende Konto Edit-Rechte hat |
| **Manuelle Zell-Edits** | je nach Schutzart blockiert oder mit Warnung |

→ Du musst **Buttons nicht von der Protection ausnehmen**. Drawings liegen über den Zellen, nicht in ihnen.

## Schutz-Setup pro Tab

Statt "ganzes Blatt schützen" überall **Bereichsschutz** verwenden — dann kann die Crew gezielt nur in den Eingabefeldern tippen.

### Eingabe-Tab

- **Schutzart:** Bearbeitung einschränken (nur du darfst, oder Crew als Editor)
- **Außer:** Eingabefelder offen lassen

```
B6              Datum
B9              Beschreibung
B12             Kategorie
B15             Bezahlt von
B18             Betrag
B21             Alkohol-Anteil
B25             Aufteilung
C31:C42         Anwesenheits-Checkboxen
```

### Gutschrift-Tab

- **Schutzart:** Bearbeitung einschränken
- **Außer:**

```
B6              Datum
B9              Beschreibung
B12             Betrag
B16             Zahlt (Von)
B19             Empfängt (An)
```

### Besatzung-Tab

- **Schutzart:** Bearbeitung einschränken
- **Außer:**

```
B5, B6          Törn-Start, Törn-Ende
B11:D22         Crew-Namen, An Bord ab/bis
F11:F22         Alkohol-x
H11:H22         Hinweis
```

> Spalten E (Tage), G (Zeitanteil %), K (Hilfsspalte für Gutschrift-An-Dropdown) bleiben geschützt — sind alles Formeln.

### Transaktionen-Tab

- **Schutzart:** **"Beim Bearbeiten dieses Bereichs eine Warnung anzeigen"** (nicht einschränken!)
- **Begründung:** Das Apps Script muss reinschreiben dürfen. "Warnung anzeigen" lässt Skript-Schreibvorgänge ungehindert durch, schützt aber vor versehentlichen manuellen Edits.

### Bilanz, Auswertung, Schulden, Kategorien

- **Schutzart:** Bearbeitung einschränken (komplett)
- **Außer:** nichts

> Schulden wird vom Skript befüllt — funktioniert ohne Probleme, weil das Skript als Owner läuft. Falls "Nur ich darf" gewählt: Skript-User muss in der Owner-Liste stehen.

## So legst du den Schutz an (Schritt für Schritt)

1. Zellbereich markieren — z. B. den ganzen Eingabe-Tab via Klick auf die Ecke oben links über Zeile 1
2. Menü **Daten → Tabellenblätter und Bereiche schützen**
3. Rechts erscheint Seitenleiste → **+ Tabellenblatt oder Bereich hinzufügen**
4. **Tabellenblatt** auswählen → entsprechenden Tab wählen
5. Häkchen bei **"Bestimmte Zellen ausschließen"** setzen → Zellen aus der Tabelle oben hier eintragen, durch Komma getrennt
   - z. B. für Eingabe: `B6, B9, B12, B15, B18, B21, B25, C31:C42`
6. Button **Berechtigungen festlegen** unten:
   - Eingabe / Gutschrift / Besatzung: "Bearbeitung einschränken" → "Nur ich" oder "Custom" mit dir als Editor
   - Transaktionen: **"Beim Bearbeiten dieses Bereichs eine Warnung anzeigen"** auswählen
7. Speichern — Schritt für jedes Tab wiederholen

## Schutz und Skript zusammen testen

Nach dem Setup:

1. **Smoke-Test:** Im Eingabe-Tab eine Test-Ausgabe eintragen → Speichern-Button klicken
   - Skript schreibt in Transaktionen ✓
   - Bilanz aktualisiert sich ✓
   - Schulden-Tab wird neu berechnet ✓
2. **Schutz-Test:** Crew-User (oder du im Inkognito) versucht, in Bilanz Zelle zu tippen → Warnung / Block
3. **Eingabe-Test:** Eingabefelder (B6/B9/B12/…) müssen weiterhin frei beschreibbar sein

## Häufige Probleme

**Skript-Fehler "You don't have permission" beim Speichern**
→ Transaktionen ist auf "Bearbeitung einschränken" statt "Warnung". Schutzart auf Warnung umstellen, oder den klickenden User als Editor des Bereichs hinzufügen.

**Crew-User kann Datum/Beschreibung nicht eintippen**
→ Eingabe-Tab ist komplett geschützt — "Bestimmte Zellen ausschließen" wurde nicht aktiviert oder die Eingabe-Zellen wurden nicht in die Ausnahme-Liste aufgenommen.

**Dropdown lässt sich nicht öffnen**
→ Dasselbe — die Zelle, in der das Dropdown ist (z. B. B12 für Kategorie), muss in der Ausnahme-Liste stehen.

**"🆕 Neuen Törn starten" scheitert**
→ Funktion löscht in Besatzung, Schulden, Transaktionen. Wenn diese strikt geschützt sind und der ausführende User kein Editor: Schutzart anpassen oder die Funktion nur als Owner ausführen.

## Schutz auf Kopien für neue Törns

Beim **Datei → Kopie erstellen** für einen neuen Törn werden alle Schutz-Einstellungen mit kopiert. Du musst das Setup also nur einmal pro Vorlagedatei machen — alle abgeleiteten Törn-Dateien sind automatisch geschützt.
