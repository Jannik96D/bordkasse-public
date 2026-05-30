# Bordkasse für Segel-Törns — Claude Code Projekt

> Tool zur fairen Aufteilung gemeinsamer Kosten auf Segel-Törns mit wechselnden Crews.
> Zwei Implementationen parallel im Repo:
> - **Sheets-Lösung** (Apps Script v11) — pragmatisch, kein Login, eingefroren.
> - **Web-App** (`webapp/`) — Next.js + Supabase + Vercel, Crew-fähig, Magic-Link-Auth, Realtime, PWA-Offline, Statistik, Audit-Log, automatische DSGVO-Löschung 30 Tage nach Törn-Ende.

## Quick Context

**Wer baut das?** Jannik, Skipper, mehrere Törns pro Jahr, bis zu 12 Crewmitglieder pro Törn, Crew teils nicht-technikaffin (Eltern, Freunde).

**Was wird gelöst?** Faire Kostenaufteilung mit Berücksichtigung von:
- Teilweiser Anwesenheit (Crewmitglieder steigen verschieden ein/aus)
- Verschiedenen Aufteilungslogiken pro Ausgabe (gleichmäßig, nur Anwesende, zeitanteilig, individuell)
- Alkohol-Anteilen (Nicht-Trinker zahlen nicht mit)
- Vorauszahlungen außerhalb der Bordkasse (Gutschriften)

**Zielsetzung:** Smartphone-tauglich, einfach genug für jedes Crewmitglied, kein Login-Aufwand.

## Aktueller Stand

Funktionierende Google-Sheets-Datei mit Apps Script. Dateien in `assets/sheets-current/`:
- `Bordkasse_IJsselmeer2026_v10.xlsx` — produktive xlsx (Layout v10, kompatibel mit Script v10 und v11)
- `Bordkasse_AppScript_v11.js` — produktiver Script-Code (manuell einzufügen)
- `Bordkasse_AppScript_v10.js` — Vorgänger-Script (Referenz)
- `Bordkasse_IJsselmeer2026_v9.xlsx` + `Bordkasse_AppScript_v9.js` — Vorgängerversion v9 (Referenz)
- `Bordkasse_IJsselmeer2026.xlsx` + `Bordkasse_AppScript_v8.js` — Vorgängerversion v8 (Referenz)

**Migrationen:** `scripts/migrate_v8_to_v9.py`, `scripts/migrate_v9_to_v10.py` — reproduzierbarer Umbau via openpyxl.

**Status:** Script-Version v11 (xlsx-Layout v10). Neu vs v10:
- Menüpunkt "🆕 Neuen Törn starten" — leert Transaktionen, Crew-Daten, Törn-Datum, Schulden, Eingabe + Gutschrift in einem Rutsch (Calc-Formeln bleiben)

## Working Language

Deutsch. Alle Domain-Begriffe sind deutsch und sollen so bleiben:
- *Bordkasse* — die gemeinsame Kasse
- *Törn* — eine Segelreise
- *Besatzung* / *Crew* — die Mitsegler
- *An Bord* — anwesend auf dem Schiff
- *Zeitanteilig* — proportional zur Anwesenheitsdauer
- *Gleichmäßig* — alle gleich
- *Gutschrift* — Verrechnung außerhalb der Bordkasse
- *Schulden* — wer wem wie viel zahlen muss
- *Bilanz* — Saldo pro Person
- *Aufteilung* — Methode, wie eine Ausgabe verteilt wird

## Architektur (aktuelle Sheets-Lösung)

### Tabs in der Excel-Datei (Reihenfolge wichtig)

1. **Eingabe** — Mobile-optimierte Eingabemaske für **Ausgaben** (Datum/Beschreibung/Kategorie/…/Aufteilung)
2. **Gutschrift** — eigenständige Maske für Gutschriften (seit v9)
3. **Besatzung** — Törn-Daten + Crew-Liste mit Anwesenheitszeiten
4. **Kategorien** — zentrale Pflege der Ausgabenkategorien (Single Source of Truth)
5. **Transaktionen** — alle Eingaben als Datensätze (Ausgaben + Gutschriften)
6. **Bilanz** — automatische Berechnung der Salden pro Person
7. **Schulden** — vereinfachter Zahlungs-Plan (per Apps Script befüllt)
8. **Auswertung** — Kategorien × Personen Matrix

### Eingabe-Tab Zellkoordinaten (kritisch für Apps Script)

```
B6   = Datum            (Autofill = heute)
B9   = Beschreibung
B12  = Kategorie        (Dropdown Kategorien!B4:B23)
B15  = Bezahlt von      (Dropdown Besatzung!B11:B22)
B18  = Betrag (€)
B21  = Alkohol-Anteil (€, optional)
B25  = Aufteilung       (Dropdown Gleichmäßig/An Bord/Zeitanteilig/Individuell)
B31–B42 = Crew-Namen (Formel-Lookup auf Besatzung!B11:B22)
C31–C42 = Anwesenheits-Checkboxen (P1–P12) für "Individuell"

Dynamische Bereiche:
- Zeilen 28–42: Individuell-Block (sichtbar nur wenn Aufteilung = "Individuell")
- Zeilen 31–42 einzeln: ausgeblendet wenn Besatzung!B(11+i) leer (live via onEdit)
```

### Gutschrift-Tab Zellkoordinaten

```
B6   = Datum            (Autofill = heute)
B9   = Beschreibung     (optional — leer → "Gutschrift" als Default-Eintrag)
B12  = Betrag (€)
B16  = Zahlt (Von)      (Dropdown Besatzung!B11:B22)
B19  = Empfängt (An)    (Dropdown Besatzung!K11:K23, inkl. "Alle")
```

### Besatzung-Tab Struktur

```
B5  = Törn-Start
B6  = Törn-Ende
B7  = Gesamttage (berechnet)

Crew-Tabelle (Zeilen 11–22, max. 12 Personen):
B = Name
C = An Bord ab
D = An Bord bis
E = Tage (berechnet)
F = Alkohol? (x für Trinker)
G = Zeitanteil % (berechnet)
H = Hinweis
K = Hilfsspalte für Gutschrift-"An"-Dropdown ("Alle" + Namen)
```

## Aufteilungs-Logiken (vier Varianten)

### 1. Gleichmäßig
Alle eingetragenen Crewmitglieder zahlen gleich viel — unabhängig von Anwesenheit.

```
Beispiel: 100€ Lebensmittel auf 10 Crew → jeder 10€
```

### 2. An Bord
Nur Personen, die am Tag der Ausgabe laut Besatzungs-Daten anwesend waren.

```
Beispiel: 80€ Restaurant am 08.04., Stephan kommt erst 10.04.
→ 9 Personen teilen 80€ → je 8,89€, Stephan 0€
```

### 3. Zeitanteilig
Proportional zur Anzahl Bord-Tage.

```
Beispiel: 210€ Sprit, 9 Personen à 11 Tage + Stephan 6 Tage = 105 Personentage
→ 11-Tage-Person: 22€, Stephan: 12€
```

### 4. Individuell
Nur explizit markierte Personen (Checkbox in der Eingabe).

```
Beispiel: 120€ Schwimmwesten für 3 Personen → je 40€
```

### Alkohol-Logik (modifiziert jede der 4 Aufteilungen)

Bei Ausgaben mit Alkohol-Anteil wird der Betrag aufgeteilt:
- Nicht-Alkohol-Teil: nach gewählter Aufteilung
- Alkohol-Teil: nur auf Personen mit "x" in Besatzung Spalte F (Alkoholtrinker)

```
Beispiel: 100€ Restaurant, 30€ davon Alkohol, "An Bord" alle 10 dabei, 3 Trinker
→ Nicht-Alkohol: 70€/10 = 7€ pro Person
→ Alkohol: 30€/3 = 10€ pro Trinker
→ Trinker: 17€, Andere: 7€
```

## Gutschrift-Logik

Gutschriften = Geld das außerhalb der Bordkasse fließt (z.B. Yacht-Vorauszahlung).

**Direkte Gutschrift** (Von Lucas → An Jannik, 240€):
- Lucas Saldo +240€ ("hat gegeben")
- Jannik Saldo -240€ ("hat erhalten")

**An Alle** (Von Lucas → An "Alle", 240€):
- Lucas hat 240€ direkt an die Crew gezahlt (z.B. seinen Yacht-Anteil nachträglich)
- Lucas: +240€
- Alle anderen Crewmitglieder bekommen anteilig zugerechnet: -240€/(N-1) je Person
- Saldo-Summe muss 0 bleiben

## Schulden-Algorithmus (Apps Script)

Greedy-Matching für minimale Anzahl Überweisungen:
1. Bilanz-Salden lesen
2. Schuldner (negativ) und Gläubiger (positiv) trennen, sortiert nach Höhe
3. Größter Schuldner zahlt an größten Gläubiger so viel wie möglich
4. Wenn einer "leer" ist, nächster Schuldner/Gläubiger
5. Maximal N-1 Überweisungen bei N Personen

## Design-System

Marineblau-dominiertes "Segel-Design", siehe `docs/design-system.md`.

Wichtigste Farben:
- `#114884` Primärblau (Texte, Linien, Rahmen)
- `#1D4281` abgedunkeltes Blau
- `#587EA8` mittleres Blau
- `#D6E1EE` helles Blau (Füllungen)
- `#FDF6DC` zartes Gold (Info-Boxen)
- Kein reines Schwarz

Schriften: Campton Bold (Display) → Arial Bold (H2) → Arial Regular (Body).

## Häufige Aufgaben für Claude Code

### Sheets-Lösung weiterentwickeln

**Neue Crew-Liste für nächsten Törn:**
- Datei in `assets/sheets-current/` öffnen
- Tab "Besatzung" Zeilen 11–22 anpassen (Name, An Bord ab/bis, Alkohol)
- Apps Script bleibt unverändert
- Wenn Personen gelöscht werden: ALLE Formelreferenzen prüfen (siehe "Bekannte Fallen")

**Apps Script erweitern:**
- Datei `Bordkasse_AppScript_v11.js` editieren
- Zellkoordinaten oben in Konstanten `E` (Eingabe), `G` (Gutschrift), `TX`, `B`, `S`
- Neue Validierungen in `transaktionSpeichern()` bzw. `gutschriftSpeichern()`
- Neue Aufteilungslogik: in Transaktionen-Sheet Spalten V–AG (P1-P12 Calc) Formel anpassen, dann Apps Script ggf. erweitern

**Neue Aufteilungsart hinzufügen:**
1. Eingabe-Tab Dropdown B25 erweitern
2. Calc-Formel in Transaktionen Spalten V–AG erweitern (verschachteltes IF)
3. Apps Script `transaktionSpeichern` ggf. mit neuer Validierung
4. Doku in `docs/calculation-rules.md` updaten

**Crew-Größe ändern (mehr/weniger als 12):**
- `B.N` im Apps Script anpassen
- Besatzung-Tab Zeilen 11–22 erweitern (alle Berechnungs-Spalten C–H)
- Eingabe-Tab Person-Zeilen 31–42 entsprechend erweitern (Formel + Checkbox-DV)
- `INDIVIDUELL_LAST_ROW`, `DABEI_COUNT` updaten
- Transaktionen Spalten V–AG (Calc) ggf. erweitern

**Strukturelle Änderungen am Tab-Layout:**
- Niemals manuell im xlsx — immer ein Migrations-Skript in `scripts/` schreiben (Vorlage: `scripts/migrate_v8_to_v9.py`)
- Skript erzeugt parallel `_vN.xlsx` + `_vN.js`, alte Version bleibt unangetastet
- openpyxl shiftet Merges + Data-Validations beim `delete_rows` NICHT automatisch — beide manuell behandeln (siehe Skript)

### Bekannte Fallen

**Beim Löschen einer Person aus Besatzung:**
- Spalte X (Person 3 Calc) bricht mit `#REF!`
- Eingabe-Labels in Zeilen 21–22 (alt) bzw. die mobile Liste nicht automatisch nachgezogen
- Bilanz-Spalte A (Name-Lookup) kann auf falsche Zeile zeigen
- **Fix:** Calc-Formel aus Nachbar-Spalte regenerieren (P2 → P3 mit `$12` → `$13`), siehe Pattern in v8

**Beim Verschieben von Spalten in Besatzung:**
- 2400+ Formeln in Transaktionen referenzieren `Besatzung!$B$11:$B$22` für Namen
- Falsche Spalten-Referenz brechen die gesamte Datei lautlos (Bilanz zeigt "00:00:00" o.ä.)
- **Fix:** Niemals manuell Spalten in Besatzung verschieben — immer komplett neu formatieren

**MATCH-Falle bei gleichen Saldenbeträgen:**
- `MATCH` gibt immer ersten Treffer zurück → wenn 9 Personen je -10€ schulden, bleibt nur die erste sichtbar
- **Fix:** Im Apps Script `schuldenBerechnen_` werden alle Schuldner einzeln behandelt, kein MATCH-Lookup mehr

## Web-App `webapp/`

**Tech-Stack:** Next.js 16 (App Router, Turbopack) + Tailwind 4 + Supabase (Postgres + Auth + Realtime) + Vercel.

**Setup:** siehe `webapp/README.md`. Lokal: `cd webapp && pnpm install && supabase start && pnpm dev`. Magic-Link-Mails landen lokal im Mailpit unter http://127.0.0.1:54324.

**Aktueller Funktionsumfang:**

- **Auth:** Magic-Link per E-Mail (Token-Hash-Flow, Single-Use, 60 Min TTL).
  - Whitelist-Check vor dem Versand: nur E-Mails in `ADMIN_EMAILS`-Env oder bereits in `persons_private` (per Skipper-Einladung) bekommen einen Link — Fremde werden mit Fehlermeldung abgewiesen, keine auth.users-Leichen.
  - Klick auf den Magic-Link landet auf `/auth/confirm` (Server Page mit „Jetzt einloggen"-Button) → POST nach `/auth/verify` → `verifyOtp` + Session. Die Zwischenseite schützt gegen Link-Scanner (Outlook Safe Links etc.), die den Token sonst per Vorab-GET verbrauchen würden.
  - Bei abgelaufenem / verbrauchtem Link redirected `/auth/verify` zurück nach `/login?auth_error=…&email=…`; die Login-Page bietet direkt einen „Neuen Link an X senden"-Button (E-Mail-Adresse wird per `&email={{ .Email }}`-Template-Parameter durchgereicht).
  - Resend-Button nach 30 s im normalen Login-Flow.
- **Rollen:** Admin (`ADMIN_EMAILS`-Env), Original-Skipper (`trips.skipper_id`), Co-Skipper (`trip_members.is_skipper`), Crew-Member. Admin kann Törns für Freunde anlegen, ohne selbst in der Crew zu landen.
- **Trips:** CRUD inkl. Archivierung; Admin sieht ALLE Trips (Service-Role-Read-Bypass via `lib/supabase/read-client.ts`), auch fremde — kein 404 beim Drauflicken.
- **Privacy-Split** (`persons` vs `persons_private`):
  - `persons.display_name` ist öffentlich (Vorname + ggf. Initial), darf NIE einen Nachnamen tragen.
  - `persons_private.last_name`, `persons_private.email` (CITEXT) — sichtbar nur für Self oder Trip-Skipper der eigenen Crew via RLS.
  - Service-Role-Schreibpfade laufen weiterhin über `createAdminClient()`.
- **Crew-Verwaltung:** Email-Einladung mit Ghost-Personen, Inline-Edit-Form (Name/Email nur für Ghosts editierbar; Anwesenheit/Alkohol/Notiz für alle).
  - **Auto-Invite-Mail:** beim Anlegen eines neuen Crew-Members wird automatisch ein Magic-Link verschickt — der Skipper muss nicht extra sagen „und jetzt geh auf /login". UPSERT-Updates (z.B. Anwesenheits-Edit) lösen KEINE Re-Invite-Mail aus.
  - **Remove-Schutz:** Crew-Member, die noch Buchungen haben (paid_by / credit_from / credit_to), können nicht entfernt werden — Skipper muss erst die Buchungen umbuchen.
- **Kategorien:** pro Trip mit lucide-react-Icon (kuratierte 23-Icon-Whitelist im Picker, `webapp/lib/categories/icons.ts`). Marineblau-monochrome Strich-Icons im Bottom-Nav-Stil. Default-Kategorien in dieser Reihenfolge: Lebensmittel→`ShoppingCart`, Restaurant→`Utensils`, Hafen / Liegeplatz→`Anchor`, Aktivitäten→`Ticket`, Ausrüstung→`Wrench`, Sprit→`Fuel`, Yacht→`Sailboat`, Versicherung→`ShieldCheck`, Kaution→`Banknote`, Sonstiges→`Package`. Render-Zeit-Fallback auf den Kategorie-Namen + Default-Icon `Tag` bei unbekannten Werten.
- **Buchungen:** alle 5 Aufteilungslogiken (Gleichmäßig, An Bord, Zeitanteilig, Individuell, **Pro Person** seit Migration 0014) + Alkohol-Modifikator (im UI unter „Erweitert" eingeklappt) + optionaler Tip-Betrag. Bei `per_person` werden die Einzelbeträge in `transaction_participants.amount` gespeichert; der Gesamtbetrag der Buchung ergibt sich aus der Summe. Currency-Input akzeptiert deutsches Komma. Idempotency-Key auf jeder Row gegen Doppelklick / Outbox-Replay.
  - **Edit-Modus:** `/trips/[id]/transactions/[txId]/edit` — Skipper, Admin oder Ersteller (`created_by`) darf eine Buchung nachträglich ändern (Aufteilung, paid_by, Beträge, …). Pencil-Icon in der Buchungsliste neben dem Lösch-Button.
- **Gutschriften** (direkt oder „An Alle") — nur Skipper/Admin. „An Alle" wird abgewiesen, wenn weniger als 2 Crew-Mitglieder dabei sind (sonst kann die Bilanz nicht ausgeglichen werden).
- **Bilanz** live aus `v_balances`.
- **Schulden** vereinfacht via `simplify_debts()`-Greedy. Bezahlt-Häkchen Crew-weit synchron in `settled_debts`; nur Schuldner, Gläubiger oder Admin dürfen togglen. Häkchen sind erst freigeschaltet, sobald der Skipper die Abrechnung verschickt hat (siehe Settlement-Workflow). **Bezahlt-Mail:** sobald jemand ein Häkchen setzt, gehen automatisch zwei Mails raus — an Schuldner UND Gläubiger. Der Wortlaut hängt vom Akteur ab (sechs Varianten, gesteuert über `actorRole: "debtor" | "creditor" | "other"` im Template): Schuldner-getriggert = „du hast deine Zahlung gemeldet" / „X hat seine Zahlung an dich abgehakt"; Gläubiger-getriggert = „X hat deine Zahlung als erhalten bestätigt" / „du hast den Empfang bestätigt"; Admin/Skipper-getriggert = neutrales „X hat das in der Bordkasse abgehakt". Beim Entfernen des Häkchens wird keine Mail verschickt. Template in `lib/email/debt-settled-template.ts`, Versand in `lib/actions/settled-debts.ts:sendDebtSettledMails` — Mail-Fehler brechen den Toggle nicht ab.
- **Settlement-Workflow:** Ab dem letzten Trip-Tag sehen Skipper/Co-Skipper/Admin einen Banner „Törn vorbei — Abrechnung verschicken?" auf Trip-Übersicht + Schulden-Seite. `announceSettlement` (in `lib/actions/settlement.ts`) berechnet aktuelle Bilanz + simplified-debts, schickt jedem Crew-Mitglied via SMTP/nodemailer eine personalisierte HTML-Mail (Saldo + Zahlungsplan + Link → Schulden-Tab), setzt `trips.settlement_announced_at`. Mail-Template-Design wie Magic-Link-Mail (Logo, Card auf #FAFBFC, table-Layout für Outlook). Idempotent: bereits angekündigte Trips können nicht erneut verschickt werden. Bei Edit/Delete einer Kaution-Buchung redirected die App auf `/trips/[id]?check_settlement=1`, was den Banner prominenter macht (border-2, Highlight-Text), damit der Skipper an die Abrechnung erinnert wird.
- **Settlement-Update-Mail:** Buchungs-Änderungen nach dem initialen Versand (create/update/delete von Expense/Credit) setzen den Marker `trips.changes_pending_since` (über `mark_post_settlement_change()`, gerufen in `lib/actions/transactions.ts`). Ist der Marker gesetzt, sieht **jedes Crew-Mitglied** auf Trip-Übersicht + Schulden-Seite einen gelben „Bilanz hat sich seit der Abrechnung geändert"-Banner mit Button „Update-Mail verschicken" — typischerweise löst die Person, die soeben die nachträgliche Buchung erfasst hat, die Mail direkt selbst aus. `resendSettlement` in `lib/actions/settlement.ts` schickt das gleiche Mail-Template mit `isUpdate=true` (Subject „Bordkasse-Update", Wortlaut „Bilanz aktualisiert"), aggregiert eine kurze ChangeSummary aus dem Audit-Log (z.B. „3 neu, 1 geändert"), setzt `last_settlement_resend_at` und löscht den Marker. Spam-Schutz: Resend funktioniert nur bei gesetztem Marker — nach jedem erfolgreichen Versand ist der Banner weg.
- **Trip-Datum-Edit:** Skipper/Co-Skipper/Admin können in den Trip-Settings unter „Törn-Datum" Start- und End-Datum nachträglich ändern (`updateTripDates` in `lib/actions/trips.ts`). Buchungen werden nicht auto-verschoben.
- **Statistik** pro Trip: Live-Aggregation nach Kategorie + Tag. Pill-Toggle „Pro Törn / Pro Person" (Client-Component `stats-view.tsx`) teilt im Pro-Person-Modus alle Geldbeträge durch die aktuelle Crew-Größe (Mengen wie Buchungs-/Tagezahl bleiben). Bleibt nach Purge anonymisiert in `trip_statistics`; Pro-Person-Toggle ist dann mangels Crew-Daten deaktiviert.
- **Gesamt-Statistik** unter `/stats`: aggregiert alle Trips eines Users (Admin: alle Trips im System) — Summary, Kategorie-Bars, Liste nach Törn (mit Drilldown), Bars nach Jahr. Datenquelle gemischt: aktive Trips live aus `transactions`, gepurgte aus `trip_statistics`. Migration 0020 fügt eine schmale `trip_statistics_audience(person_id, trip_id)`-Tabelle hinzu, die beim Purge mit den damaligen Member-Person-IDs (nur mit `auth_user_id`) befüllt wird — RLS-Policies auf `trips` + `trip_statistics` sind um den Audience-Pfad erweitert, damit reguläre User auch nach Purge ihre Cross-Trip-Daten sehen. Query: `lib/queries/global-stats.ts:getGlobalStats`. Einstieg via Link am Seitenende der Trip-Auswahl.
- **Self-Service-Kontolöschung** (DSGVO Art. 17): `/profile` → Block „Konto löschen". Migration 0021 liefert `delete_my_account()` (SECURITY DEFINER, GRANT EXECUTE TO authenticated): anonymisiert `persons` (display_name → „Ehemaliges Crew-Mitglied", auth_user_id NULL), löscht `persons_private`, `trip_statistics_audience` und Pre-Trip-`trip_members` ohne Buchungs-Spur. Action `deleteMyAccount` in `app/profile/actions.ts` ruft die Function via `admin.rpc` und löscht zusätzlich die `auth.users`-Row. **Blocker:** Buchungen (paid_by / credit_from / credit_to / transaction_participants) in einem aktiven Trip (`end_date >= today`, nicht gepurged) → Action returnt `has_active_bookings`, der User muss bis nach Trip-Ende warten oder den Skipper bitten, seine Buchungen umzubuchen. Nach erfolgreichem Löschen Redirect auf `/?account_deleted=1` mit kleinem Bestätigungs-Banner.
- **PWA:** Service Worker (`public/sw.js`) cached App-Shell; IndexedDB-Outbox erfasst Buchungen offline und synchronisiert beim Reconnect.
- **Audit-Log:** jede Schreib-Operation hinterlässt einen Eintrag, RLS-Lese-Schutz auf Skipper.
- **Soft-Delete:** Buchungen tragen `deleted_at` statt physisch gelöscht zu werden.
- **DSGVO-Datenlöschung:** täglicher Vercel-Cron `/api/cron/purge` → `purge_expired_trip_data()`. Purge nur wenn end_date + 30 Tage in Vergangenheit UND `settlement_announced_at` gesetzt UND alle `simplify_debts` in `settled_debts` abgehakt (Helper `all_debts_settled`). Single-Trip-Variante `purge_trip_data(trip_id, force)` für den manuellen Skipper-/Admin-Button in den Trip-Settings; Force überspringt Retention + Settlement, NICHT Schulden. Trip-Auswahl-Seite markiert überfällige Trips rot + Banner für Skipper/Admin (`retention_overdue`-Flag in `listMyTrips`). Aggregierte Statistik bleibt in `trip_statistics`.
- **Public Pages (kein Login nötig):** `/`, `/login`, `/datenschutz`, `/about` — in `middleware.ts` als `PUBLIC_ROUTES` eingetragen. `/about` ist die Funktionsübersicht der App mit **17 Mobile-Screenshots** aus echtem Betrieb (synthetische Crew, keine echten Personendaten) — inklusive drei Anzahlungs-Karten (Setup-Wizard, Matrix mit Charter-Banner, Crew-Self-View). Jeder Screenshot wird über die Client-Component [`webapp/app/about/feature-shot.tsx`](webapp/app/about/feature-shot.tsx) **vollständig (kein Crop) in einem flach-minimalen Phone-Frame** dargestellt (dünne Bezels, große Eckenradien, on-brand dunkler Rahmen `bg-ink`, bewusst KEINE Notch — würde Inhalt verdecken und schnell veraltet wirken); Tap öffnet eine Vollbild-Lightbox zum Reinzoomen. Die Features sind in einem **Phasen-Explorer** [`webapp/app/about/about-explorer.tsx`](webapp/app/about/about-explorer.tsx) organisiert (Client-Component, bekommt die Phasen-Daten inkl. vorgerendeter Icons + JSX-`body` vom Server-`page.tsx`): eine **sticky ARIA-Tab-Leiste** schaltet zwischen den 5 Törn-Phasen um (mobil horizontal scrollbar, Pfeil-/Home-/End-Tastatursteuerung, roving tabindex), nur die aktive Phase ist sichtbar. Pro Feature ein **alternierendes Zwei-Spalten-Layout** ab `md` (Phone mal links, mal rechts, Text daneben), auf Mobile gestapelt. „Mehr Details" ist progressive disclosure NUR auf Mobile (`<details>` eingeklappt) — auf Desktop ist der Erklärtext direkt neben dem Phone offen. Deep-Links: `#<phaseId>` öffnet die Phase, `#<featureId>` öffnet die passende Phase und scrollt zum Feature (Live-`hashchange`). Die Screenshots liegen als **WebP** (~65 % kleiner als PNG, von `page.tsx` referenziert); das erste Bild der aktiven Phase lädt `eager`/`fetchPriority=high` (LCP), die Nachbarphasen werden in der Idle-Zeit vorgeladen. Screenshots reproduzierbar via `webapp/scripts/take-screenshots.ts` (Playwright nimmt PNG-Buffer auf → `sharp` schreibt WebP raus; + Mailpit-Magic-Link + lokales Supabase). Komplettes Demo-Setup über das Helper-Skript [`webapp/scripts/seed-demo.sh`](webapp/scripts/seed-demo.sh) — es macht `supabase db reset`, fängt das kaputte `seed.sql` ab, legt Auth-User für Anna + Clara via Admin-API an (direkte `auth.users`-INSERTs sind in der aktuellen Supabase-Version unzuverlässig — „Database error finding user"), spielt `seed_demo.sql` ein und verknüpft `persons.auth_user_id`. Mit `--screenshots` läuft im Anschluss die Playwright-Pipeline. Demo enthält **zwei Trips**: „Pfingst-Törn Ostsee 2026" (gestern beendet → Settlement-Banner sichtbar) und „Bareboat-Charter Sommer 2027" (Anzahlungs-Plan mit Kojen, Vorstrecker Anna, 2 Tranchen, gemischte Zahlungs-Stati inkl. einer Pending-Selbstmeldung). Clara hat einen eigenen Auth-User für den Crew-Self-View-Screenshot (Re-Login mid-pipeline).
  - **Screenshot-Runbook (WICHTIG, gegen Mac-Überlast):** Screenshots IMMER gegen den **Production-Server** (`pnpm build` → `pnpm start`) aufnehmen, NICHT gegen `pnpm dev`. Turbopack-Dev kompiliert Routen lazy → Playwright läuft in 30s-`load`-Timeouts und unter gleichzeitiger colima/supabase/dev-Last kann der Mac einfrieren. Bewährte Reihenfolge: (1) `colima start`, (2) `supabase start` + blockieren bis API 200, (3) `./scripts/seed-demo.sh`, (4) `pnpm build` — Schritte 1–4 als je eigenes abgeschlossenes Kommando; (5) `pnpm start &` + Routen vorwärmen (`curl / /login /about`) + `take-screenshots.ts` + `kill` in EINEM Kommando. Kein Background-Polling über Turns, kein `|| echo`, kein Retry-Loop. Vollständiges Runbook im Kopf-Kommentar von `webapp/scripts/take-screenshots.ts`. Code-Push immer von Screenshots entkoppeln.
- **Hosting-Region:** Vercel `regions: ["fra1"]` in `vercel.json` (sonst US-Default `iad1`); Supabase Central EU (Frankfurt); Mailserver whost.dev (DE).
- **Security:** RLS-Policies, Service-Role nur in Server Actions, Security-Header (HSTS/CSP/X-Frame/Referrer-Policy), `noindex`-Meta + `robots.txt`.
- **Explizite Data-API-GRANTs (Migration 0022):** Supabase deprecatet ab 30.10.2026 die automatischen `GRANT`s auf neue Tabellen im public-Schema. Migration `0022_explicit_grants.sql` setzt deshalb für alle bestehenden Tabellen/Views/`simplify_debts()` explizite `GRANT … TO authenticated` und definiert via `ALTER DEFAULT PRIVILEGES` Defaults für künftige Tabellen. **Konsequenz für neue Migrationen:** `CREATE TABLE foo …` reicht aus, der GRANT kommt automatisch — kein manuelles `GRANT` pro Migration nötig. RLS-Policies aus 0004 filtern weiterhin pro Row.
- **Anzahlungs-Modul** (Migrationen 0023–0028, Spec `docs/prepayments.md`): Mechanik für Yacht-Anzahlungen, die der Skipper Monate vor Törn-Start an die Charteragentur leistet und sich von der Crew rückerstatten lässt.
  - **Wizard** unter `/trips/[id]/prepayments/setup` (zwei Schritte): Aufteilung (`gleichmaessig` / `zeitanteilig` / `individuell` / `kojen`) + Vorstrecker-Auswahl + optional Kojen-Editor + WhatsApp-Vorlage; Schritt 2 = Tranchen-Liste mit Fälligkeit + Prozent (Σ = 100). Crew kann inline im Wizard angelegt werden (`CrewQuickAdd`).
  - **Matrix** unter `/trips/[id]/prepayments`: Person × Tranche mit Status-Symbolen (○ offen, ◐ teilweise, ✓ bezahlt, ⏰ überfällig, ⏳ pending). Klick auf Zelle → Modal zur Zahlungs-Erfassung mit Überzahlungs-Splitting auf zweite Tranche. Pro Person-Zeile 🔔 (Erinnerungs-Mail) und 💬 (WhatsApp-Text). Sammel-Text-Button oben. Charter-Reminder-Banner für den Vorstrecker zeigt, was er an die Agentur noch überweisen muss (mit Überfälligkeits-Indikator). Vorstrecker-Zeile trägt blaues VORSTRECKER-Badge, Bell/WhatsApp-Buttons sind in seiner Zeile deaktiviert.
  - **Vorstrecker:** wer streckt die Yacht-Anzahlung vor (Default = Trip-Skipper, im Wizard editierbar). Migration 0024 relaxed `tx_credit_self` für tranche-getaggte Credits, damit der Vorstrecker seinen eigenen Anteil als Selbst-Verrechnung abhaken kann (bilanzneutral). Der Vorstrecker darf abhaken, bestätigen, ablehnen und Erinnerungen verschicken — auch wenn er nicht Trip-Skipper ist (`requireSkipperAdminOrAdvancer` in `lib/auth/authz.ts`).
  - **Phase 2 — Crew-Selbstmeldung** (Migration 0025): Crew klickt in `/prepayments` „Ich habe gezahlt" → Eintrag mit `transactions.confirmed_at = NULL` (= pending). Vorstrecker bekommt eine Mail (`payment-pending-template.ts`) und sieht in der Matrix einen gelben Pending-Banner mit ✓ / ✗ Buttons. Erst bei Bestätigung zählt der Eintrag in `v_prepayment_payments`. `transactions.confirmed_at` hat `DEFAULT now()` — normale Skipper-/Admin-Eingaben sind sofort bestätigt, nur `submitSelfPayment` schreibt explizit NULL.
  - **Crew-Fälligkeit 3 Tage vor Charter:** `prepayment_tranches.due_date` ist die Charter-Fälligkeit (gegenüber Agentur). Überall, wo die Crew die Frist sieht (Matrix-Header, Crew-Self-View, Erinnerungs-Mail, WhatsApp), wird über `toCrewDueDate()` in `lib/prepayments/dates.ts` ein 3-Tage-Puffer abgezogen. Der Charter-Reminder-Banner zeigt weiterhin das echte Datum.
  - **Bilanz Drei-Block-Übersicht** (in `/trips/[id]/balance` wenn ein Plan existiert): Anzahlungs-Pool / Bordkasse / Gesamt pro Person. Anzahlungs-Saldo = aktiv_beigetragen − soll (pragmatisch, nicht double-entry: credit_to des Vorstreckers zählt NICHT negativ bei ihm, weil treuhänderisch). Bordkasse-Saldo kommt aus separater View `v_balances_bordkasse_only` (Migration 0026, filtered auf `tranche_id IS NULL`). Untere Tabelle ist konsistent: zeigt nur Bordkasse-Buchungen wenn ein Plan existiert.
  - **Crew-Wechsel-Workflow:** `replaceMember` in `lib/actions/prepayments.ts` legt neue Person an, überträgt Obligation + Anwesenheit + Koje, erzeugt Gegen-Gutschriften für die bereits geleisteten Anzahlungen (B zahlt A privat aus → A geht auf 0 €, B rutscht in A's Position). Ghost-Crew ohne E-Mail-Adresse möglich; bei nachträglich eingetragener E-Mail wird der Ghost automatisch in den bestehenden Account integriert (`mergeGhostIntoExistingPerson` in `lib/actions/trip-members.ts`), außer real und Ghost wären beide schon Crew des selben Trips — dann Block mit klarer Meldung.
  - **Tranche-Dropdown in normaler Buchungs-/Gutschrift-Form** (`webapp/app/trips/[id]/transactions/new/transaction-form.tsx`): optional eine Tranche zuordnen, dann landet die Buchung im Anzahlungs-Pool (taucht nicht im Bordkasse-Saldo auf). Die Yacht-Anzahlung wird so erfasst.
  - **Auto-Merge bei Crew-E-Mail-Kollision:** Wenn beim Inline-Edit einer Ghost-Crew eine E-Mail nachgetragen wird, die schon zu einem bestehenden Account gehört, mergt die Action den Ghost automatisch in den bestehenden Account (alle transactions, prepayment_obligations, trip_members, audit_log, settled_debts werden umgehängt). Pre-Check: ist die echte Person bereits Mitglied desselben Trips → Block mit Aufforderung, manuell aufzuräumen.
  - **A11y:** alle interaktiven Zellen tragen einen vollen Kontext-`aria-label` („Lucas, Endzahlung: bezahlt, 180,00 € von 180,00 € bezahlt"), Status-Emojis sind `aria-hidden="true"`. Pending-Banner ist `role="region"`. Touch-Targets ≥ 44px.
  - **Charter-Reminder-Mail an Vorstrecker** (`charter-reminder-template.ts`): wenn der 🔔-Button in der Vorstrecker-Zeile geklickt wird, schickt die App eine Charter-Übersicht statt einer persönlichen Tranchen-Liste — pro Tranche Soll Agentur, Σ Crew-Eingänge bei mir, schon-überwiesen, noch offen. `send-prepayment-reminder.ts` routet zwischen Crew-Pfad und Vorstrecker-Pfad anhand von `personId === advancer_person_id`.
  - **Auto-Reminder-Cron** (Migration 0028 + `/api/cron/prepayment-reminders`, in `vercel.json` als täglicher Cron `0 7 * * *` eingetragen): verschickt **innerhalb der letzten 6 Tage vor Charter-Frist** eine Reminder-Mail an offene Crew-Mitglieder (`crew_3d`, ab 6 Tagen = 3 Tage vor Crew-Frist) und **innerhalb der letzten 3 Tage** eine Charter-Übersicht an den Vorstrecker (`advancer_3d`). Fenster statt exakter Tag, damit ein verpasster Cron-Tag (Deploy, Outage) keinen Reminder verliert. Dedup über `prepayment_reminder_log(tranche_id, person_id, reminder_type)` — pro Kombi höchstens ein Eintrag. **Pending-Awareness:** Crew-Mitglieder mit unbestätigter Selbstmeldung (`v_prepayment_pending`) werden NICHT erneut gemahnt — sie haben ihren Teil getan und warten auf den Vorstrecker. **Advancer-Skip:** der Vorstrecker bekommt keine `advancer_3d`-Mail mehr, wenn er die Tranche bereits voll an die Agentur überwiesen hat. **Reject räumt Dedup-Log:** bei Ablehnung einer Selbstmeldung (`rejectSelfPayment`) wird der `crew_3d`-Log-Eintrag gelöscht, sodass der Cron einen korrigierten Reminder verschicken kann. Abgelaufene Trips übersprungen.
  - **Notice-Mails bei Admin-Aktionen** (`prepayment-notice-template.ts`, `sendPrepaymentNoticeMails` in `lib/actions/prepayments.ts`): wenn `recordPayment` / `confirmSelfPayment` / `rejectSelfPayment` von einer dritten Person (Admin/Co-Skipper) ausgelöst wird, gehen Info-Mails an Crew-Person + Vorstrecker (sofern der Actor nicht selbst Empfänger wäre). Self-Aktionen (Actor == Crew oder Actor == Vorstrecker) lösen keine Notice-Mail aus. Für Schulden-Häkchen (`sendDebtSettledMails`): bei Admin-Drittaktion bekommen Skipper UND Vorstrecker zusätzlich eine neutrale Observer-Mail, sofern sie nicht ohnehin Schuldner/Gläubiger sind.

**Mail-Design einheitlich** über [`lib/email/mail-shell.ts`](webapp/lib/email/mail-shell.ts) — `renderMailShell` rendert Logo-PNG-Header + Card-Wrapper + Footer, Helper `renderActionButton`, `renderHintBlock`, `escapeHtml`, `fmtEuro`. Alle sieben Templates (settlement, debt-settled, debt-observer, prepayment-reminder, charter-reminder, payment-pending, prepayment-notice) nutzen dasselbe Shell. Wero-Hinweis-Text dynamisch: „Bitte schicke {Vorstrecker} per Wero die fällige Anzahlung" — keine Klick-Links (Wero hat keine öffentliche API), Wero-ID + Verwendungszweck als Pille zum manuellen Übernehmen.

**Berechnungslogik:** in `webapp/supabase/migrations/0002_views.sql` (`v_transaction_shares`), `0003_functions.sql` (`simplify_debts()`), `0023_prepayments.sql` (`v_prepayment_payments`), `0025_self_payment_confirmation.sql` (`v_prepayment_pending`) und `0026_bordkasse_only_balances.sql` (`v_balances_bordkasse_only`). TS-Mirror in `webapp/lib/calc/` — nur für Vitest, nicht im Render-Pfad. Anzahlungs-Soll-Berechnung in `webapp/lib/calc/prepayment-shares.ts` (`calculateObligations`).

**Wichtige Architektur-Entscheidungen:**
- **Schreib-Pfad:** Server Actions schreiben mit dem Service-Role-Client (`lib/supabase/admin.ts`), weil das User-JWT in Next.js 16 Server Actions die DB nicht zuverlässig erreicht. Auth/Authz wandert dadurch ins App-Layer (`lib/auth/authz.ts` mit `requireAuth/Skipper/Admin/SkipperOrAdmin/Member` + `isEmailAllowedToSignIn`).
- **Lese-Pfad:** alle Lese-Queries laufen über `lib/supabase/read-client.ts:readClient()`. Für globale Admins (in `ADMIN_EMAILS`) liefert es den Service-Role-Client → bypass RLS, damit Admins fremde Törns sehen. Für alle anderen User → Cookie-basierter Client mit aktivem RLS.
- **Cookie-Binding in Auth-Routes:** `/auth/verify` (POST) erstellt zuerst die Redirect-Response, dann `createClient(response)`. Der Cookie-Adapter schreibt Set-Cookie direkt auf die Response, sonst landen Session-Cookies nicht im Browser (siehe Supabase Discussion #35615).

**Auth-Email-Template:** liegt in `webapp/supabase/email-templates/magic-link.html` als Repo-Snapshot — wird im Supabase-Dashboard manuell oder via Management-API gepflegt. URL-Pattern: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&email={{ .Email }}` (NICHT `{{ .Type }}` — Supabase rendert das bei Magic-Links als leeren String).

**Deploy:** Vercel mit Root Directory `webapp`. Pflicht-Env-Vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (Production-Origin, fail-loud wenn fehlt — `lib/auth/origin.ts` braucht das für Magic-Links und Mail-Links aus Cron-/Background-Pfaden), `NEXT_PUBLIC_APP_ORIGIN` (gleicher Wert, von Mail-Templates verwendet), `ADMIN_EMAILS`, `CRON_SECRET`, SMTP-Credentials (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`).

**Tests:** Vitest (`__tests__/calc.test.ts` + `schema.test.ts` + `prepayments.test.ts`) gegen S1–S7 sowie das Spec-Szenario „Yacht-Anzahlung mit Kojen", Playwright (`e2e/smoke.spec.ts`) für öffentliche Routes + Auth-Schutz + Security-Header.

## Projekt-Dateien

```
.
├── CLAUDE.md                            # Dieses Briefing
├── docs/
│   ├── design-system.md                 # Komplettes Segel-Design
│   ├── calculation-rules.md             # Alle Aufteilungslogiken im Detail
│   ├── apps-script-reference.md         # Apps Script Funktionen + Zell-Mapping
│   ├── buttons-setup.md                 # Klickbare Speichern-Buttons in Google Sheets einrichten
│   ├── protection-setup.md              # Tabellenblätter schützen, Eingabefelder offen lassen
│   ├── prepayments.md                   # Anzahlungs-Modul Spec (Tranchen, Wizard, Matrix, Selbstmeldung)
│   └── web-app-spec.md                  # Migrations-Spezifikation
├── scripts/
│   ├── migrate_v8_to_v9.py              # Reproduzierbarer xlsx-Umbau v8→v9
│   └── migrate_v9_to_v10.py             # Reproduzierbarer xlsx-Umbau v9→v10
├── webapp/                              # Web-App (Next.js + Supabase) — Setup in webapp/README.md
│   ├── app/                             # App Router (Trips, Auth, Profile, Stats, Cron, About)
│   │   ├── about/                       # Public Funktionsübersicht mit Screenshots
│   │   └── trips/[id]/prepayments/      # Anzahlungs-Modul: Matrix, Wizard, Crew-Self-View
│   ├── components/                      # bottom-nav, realtime-trip, offline-banner, sw-register
│   ├── lib/                             # supabase, auth (mit authz), actions, queries,
│   │                                    # calc, validation, categories/icons, offline, db/audit,
│   │                                    # prepayments/ (dates, whatsapp), email/ (templates + send)
│   ├── public/                          # Logo, Manifest, Service Worker, robots.txt
│   │   └── about/                       # 17 Mobile-Screenshots (WebP) für /about-Seite (15-17 = Anzahlungen)
│   ├── scripts/                         # take-screenshots.ts (Playwright) + seed-demo.sh
│   ├── supabase/                        # config.toml + migrations + email-templates + seed
│   │                                    # + seed_demo.sql (2 Trips: Pfingst + Bareboat-Charter mit Anzahlungs-Plan)
│   │                                    # + seed_prepayments_test.sql (Trip mit Crew für Anzahlungs-Tests)
│   ├── __tests__/                       # Vitest (calc, schema, prepayments)
│   └── e2e/                             # Playwright Smoke-Tests
├── .github/workflows/webapp-ci.yml      # CI für webapp/ (lint + typecheck + test)
└── assets/
    ├── sheets-current/
    │   ├── Bordkasse_IJsselmeer2026_v10.xlsx    # produktive xlsx
    │   ├── Bordkasse_AppScript_v11.js           # produktives Script
    │   ├── Bordkasse_AppScript_v10.js           # v10-Script-Referenz
    │   ├── Bordkasse_IJsselmeer2026_v9.xlsx     # v9-Referenz
    │   ├── Bordkasse_AppScript_v9.js            # v9-Referenz
    │   ├── Bordkasse_IJsselmeer2026.xlsx        # v8-Referenz
    │   └── Bordkasse_AppScript_v8.js            # v8-Referenz
    └── design/
        └── (Logo, Bilder werden ergänzt)
```

## Wichtige Prinzipien

**Pragmatik vor Perfektion.** Die Sheets-Lösung wurde gewählt weil sie ohne Login funktioniert und die Crew sie sofort nutzen kann. Eine Web-App wäre technisch sauberer, hätte aber höhere Einstiegshürde.

**Deutsch ist verbindlich.** Auch in Kommentaren, Variablen optional englisch.

**Mobile zuerst.** Nicht-technikaffine Crew sitzt auf der Yacht mit Smartphone in der Hand, nicht am Laptop. Touch-Targets ≥ 40px Höhe, große Schrift, vertikal gestapelt.

**Fail-Safe.** Lieber ein Feld zu viel ausblenden als die Crew mit ungültigen Optionen verwirren. Apps Script validiert vor dem Speichern.

**Audit-Trail.** Transaktionen sind append-only — niemand löscht versehentlich Daten. Korrekturen über neue Gutschrift-Einträge.

**Barrierefreiheit mitdenken.** Bei jeder Änderung in der Web-App (`webapp/`) als Grundlinie WCAG 2.1 AA anstreben:
- Farbe ist nie alleiniger Informationsträger (z. B. Bilanz nutzt Farbe **und** „+/−"-Zeichen + Screenreader-Text).
- Jeder interaktive Bereich ist per Tastatur erreichbar und hat sichtbaren Fokus-Indikator (`focus:ring-2 focus:ring-primary/20` ist der Default).
- Custom-Komponenten folgen ARIA-Patterns (Listbox mit `aria-activedescendant` + Pfeil-Navigation, kein eigenes Wheel neu erfinden).
- Skip-Link in `app/layout.tsx` zum `#main-content`-Wrapper; `<html lang="de">` ist gesetzt.
- `prefers-reduced-motion` wird in `globals.css` respektiert — neue Animationen brauchen kein eigenes Handling.
- Touch-Targets mindestens 44 px (Default via `--spacing-touch` in `globals.css`).
- Form-Inputs haben Label-Verknüpfung (`htmlFor` / `id`); Fehler-Meldungen tragen `role="alert"`, Erfolgs-Meldungen `role="status"`.
- Bilder bekommen aussagekräftige `alt`-Texte, dekorative Icons `aria-hidden`.

Vor dem Mergen einer neuen Komponente kurz prüfen: kann ich nur mit Tab + Pfeiltasten alles bedienen? Sieht der Fokus-Ring sichtbar aus? Liest VoiceOver/TalkBack sinnvolle Texte?

## Anweisungen für Claude Code

Wenn du in diesem Projekt arbeitest:

1. **Lies erst die Doku in `docs/`**, bevor du Änderungen machst — besonders `apps-script-reference.md` für Zellkoordinaten.
2. **Bei Sheets-Änderungen:** Datei in `assets/sheets-current/` direkt editieren (oder Kopie mit neuer Versionsnummer anlegen).
3. **Bei Apps Script-Änderungen:** Versionsnummer im Header inkrementieren (`v11` → `v12`), Changelog am Anfang der Datei aktualisieren.
4. **Bei strukturellen Änderungen** (neue Spalten, neue Tabs): IMMER alle Formel-Referenzen prüfen — siehe Pattern in den Recovery-Scripts in `docs/`.
5. **Testen mit den Szenarien** in `docs/calculation-rules.md` — alle 7 müssen weiterhin korrekt rechnen.
