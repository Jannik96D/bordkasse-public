# Design-System: Segeln mit Jannik

Marineblau-dominiertes, reduziertes Design. Ursprünglich für gedruckte Törn-Dokumente entwickelt, jetzt für Spreadsheet-Tools übernommen. Bei Web-App-Migration soll dieses Design in Tailwind/CSS-Variablen übersetzt werden.

## Farbpalette

### Primär
| Variable | Hex | Verwendung |
|---|---|---|
| `--navy` | `#114884` | Texte, Linien, Rahmen, Icons, Füllungen — die dominante Farbe |
| `--navy-2` | `#1D4281` | Sekundäre fette Überschriften, Strokes |
| `--teal` | `#587EA8` | Tertiär — sekundäre Linien, Tabellengitter |
| `--teal-light` | `#D6E1EE` | Helle Füllungen mit reduzierter Opazität |

### Funktional
| Variable | Hex | Verwendung |
|---|---|---|
| `--gray` | `#808284` | Gepunktete Ausfülllinien |
| `--gray-light` | `#F4F6F8` | Sehr heller Hintergrund |
| `--gray-mid` | `#E8EBF0` | Abgesetzte Zellen / Striping |
| `--white` | `#FFFFFF` | Hintergrund + invertierte Texte |

### Akzente (Status)
| Variable | Hex | Verwendung |
|---|---|---|
| `--green` | `#1E8449` | Positive Bilanz, Erfolg |
| `--green-light` | `#E8F3EC` | Zarter Hintergrund |
| `--red` | `#A93226` | Negative Bilanz, Fehler |
| `--red-light` | `#F5E4E0` | Zarter Hintergrund |
| `--gold` | `#C8A51E` | Pflicht-Hervorhebung, Hinweisboxen |
| `--gold-light` | `#FDF6DC` | Info-Box-Hintergrund |

**Wichtig: Kein reines Schwarz.** Selbst Fließtext immer in `--navy`.

## Typografie

Hierarchie strikt einhalten:

```
Display (Cover, große Titel):  Campton Bold,    36pt / 30pt,  --navy
H2 (Sektionen, Felder):        Arial Bold,      15-16pt,      --navy
Body, Labels, Listen:          Arial Regular,   12-13pt,      --navy
```

In Spreadsheets ist Campton meist nicht installiert → Fallback: `"Campton Bold, Arial"`.

In Web-App: Campton von Adobe Fonts laden, sonst Arial / system-ui Fallback.

## Logo / Branding

Stilisiertes Segel-Icon:
- Zwei abstrahierte, sich überlappende Dreiecke in `--navy`
- Kleines Steuerrad-Icon oben links im vorderen Segel
- Auf Covern: 80–100pt
- Auf Innenseiten: 30–40pt in oberen Ecken
- Doppelt als Seitenzahl-Badge: weiße Zahl auf blauem Segel

SVG-Vorlage:
```svg
<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
  <path d="M 12 32 L 12 8 L 28 32 Z" fill="#114884"/>
  <path d="M 20 32 L 20 12 L 32 32 Z" fill="#114884" opacity="0.7"/>
  <circle cx="14" cy="11" r="2.5" fill="none" stroke="#fff" stroke-width="1"/>
</svg>
```

## Layout-Prinzipien

### Cover (Print)
- Asymmetrischer Split ~55% Bild / 45% Weiß
- Linke Hälfte: großformatiges Stimmungsfoto (Meer, Segel, Horizont)
- Rechte Hälfte: weiß, Logo oben rechts, Titel unten rechts

### Inhaltsseiten
- Dichte, aber aufgeräumte Anordnung
- Inhalte in klar abgegrenzten Boxen organisiert
- Jeder Inhalts-Block hat einen Titel auf der oberen Rahmenkante

### Spreadsheet-Tabs
- Header-Zeile in `--navy` mit weißem Text, 28-50pt hoch
- Subheader in `--teal` 
- Zebra-Striping mit `--white` und `--gray-light`
- Höhepunkt-Zellen (z.B. Betrag) mit `--gold-light` hinterlegen
- Sektion-Trennung durch Spacer-Zeilen (8-14pt hoch)

## Box- und Rahmensystem

### Eigenschaften
- **Rahmenfarbe:** `--navy`, 1pt Linienstärke
- **Kein Hintergrund:** Boxen transparent/weiß gefüllt
- **Section-Header:** Bold-Label direkt auf der oberen Rahmenlinie, mit horizontaler Linie nach rechts erweitert

### Icons
- Klein, monochrom, in `--navy`
- Links neben Section-Titel innerhalb des Rahmens
- Beispiele: Kompass für "Törn", Skipper-Mütze für "Skipper*in", Segelboot für "Schiff", Notiz für "Notizen"

## Formular-Elemente

### Eingabefelder
- Rahmen: `--navy`, mittlere Stärke (1.5pt) für Hervorhebung
- Hintergrund: weiß für Standard, `--teal-light` für Pflichtfelder, `--gold-light` für Betrag
- Schrift: Arial Bold, 14-22pt (auf Mobile größer)

### Ausfülllinien (Print)
- Gepunktete Linien `· · · · · ·` in `--gray` oder `--teal`
- Markieren Platzhalter für handschriftliches Ausfüllen

### Checkboxen
- Quadratisch, leer (□)
- `--navy`, 10–12pt für Print, 18pt für Mobile
- Konsistenter Abstand zum Text

### Labels
- Zweisprachig deutsch/englisch (im Print-Kontext)
- Deutsch oben fett, Englisch direkt darunter regular
- Im Spreadsheet: nur deutsch

## Tabellen

- **Rahmen:** dünne Linien in `--navy` oder `--teal`
- **Kopfzeilen:** fett, gleiche Farbe, kein farblicher Hintergrund (außer in Spreadsheets, wo Header-Zeilen mit `--navy`-Hintergrund eingefärbt sind)
- **Zeilenabstand:** großzügig
- **Stil:** schlicht, keine Zebra-Streifen im Print, im Spreadsheet alle 2 Zeilen abwechselnd

## Bildsprache (Print)

Nur auf Cover und Rückseiten:
- Reale Segelfotos, natürliche Farbgebung
- Motiv: Meer, Segel, Horizont, Berge/Inseln in der Ferne
- Leicht entsättigte, blaustichige Nachbearbeitung — harmoniert mit Marineblau-Palette
- Rückseiten: stimmungsvolle Horizonte / Sonnenuntergänge

## Ton & Atmosphäre

Professionell-maritim, aber einladend.

Die Kombination aus:
- Tiefem Marineblau
- Klaren geometrischen Formen (Campton Bold)
- Funktionaler Arial
- Weiß-dominiertem Layout

erzeugt ein sauberes, seriöses Erscheinungsbild — das trotzdem nicht steif wirkt. Passend für ein offizielles Segel-Dokument, das auch Spaß machen soll.

## Übertragung in Web-App (Tailwind-Konfiguration)

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#114884',
          dark: '#1D4281',
        },
        teal: {
          DEFAULT: '#587EA8',
          light: '#D6E1EE',
        },
        sail: {
          gold: '#C8A51E',
          'gold-light': '#FDF6DC',
        },
      },
      fontFamily: {
        display: ['Campton', 'Arial', 'sans-serif'],
        sans: ['Arial', 'system-ui', 'sans-serif'],
      },
    },
  },
};
```

Dann z.B.:
```jsx
<div className="border border-navy bg-white p-4">
  <h2 className="text-navy font-bold text-lg">  ⚓  Bordkasse</h2>
  <p className="text-navy">Eingabe-Inhalte ...</p>
</div>
```
