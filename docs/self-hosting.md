# Self-Hosting: Bordkasse auf eigenem Server (Coolify)

Runbook für den Umzug von Supabase Cloud + Vercel auf einen selbst
gehosteten Stack.

**Warum überhaupt:** Der Supabase-Free-Tier pausiert ein Projekt nach ~7
Tagen Inaktivität. Da nicht jede Woche ein Törn stattfindet, schlief die
Bordkasse regelmäßig ein. Selbst gehostet gibt es diese Regel nicht — es
sind Docker-Container, die laufen, bis jemand sie stoppt.

---

## 1. Architektur

Sieben Container statt der 14 des vollen Supabase-Stacks — im Normalbetrieb
laufen davon **fünf**, weil `studio` und `meta` im Compose-Profil `studio`
liegen und nicht automatisch starten (RAM-Optimierung, siehe Abschnitt 12).
Weggelassen ist nur, was die App nachweislich nicht nutzt:

| Container | Rolle |
|---|---|
| `db` | Postgres 17 — der eigentliche Datenbestand |
| `auth` | GoTrue, verschickt die Magic-Link-Mails |
| `rest` | PostgREST, bedient alle Lese-Queries der App |
| `realtime` | Live-Updates für `components/realtime-trip.tsx` |
| `meta` | Backend für Studio (Compose-Profil `studio`, startet nicht automatisch) |
| `studio` | Web-UI auf die Datenbank (Compose-Profil `studio`, startet nicht automatisch) |
| `kong` | interner API-Gateway, bündelt alle Pfade unter einer URL |

**Nicht dabei:** `storage` + `imgproxy` (die App nutzt Supabase Storage an
keiner Stelle), `functions` (keine Edge Functions), `supavisor` (nur ein
Client, kein Pooling nötig), `analytics` + `vector` (Logs kommen aus
Coolify). Ersparnis ~1–1,5 GB RAM.

Alle Dateien liegen in [`webapp/supabase/self-host/`](../webapp/supabase/self-host/).

### Speicherbedarf

**Gemessen** auf dem laufenden Stack (`docker stats --no-stream`), nach der
RAM-Optimierung vom 05.08.2026:

| Container | RAM | vorher |
|---|---|---|
| realtime | 201 MB | 202 MB |
| kong | 81 MB | **614 MB** |
| db | 74 MB | 78 MB |
| auth | 10 MB | 9 MB |
| rest | 9 MB | 22 MB |
| studio | — (Profil) | 197 MB |
| meta | — (Profil) | 85 MB |
| **Summe** | **375 MB** | **1.207 MB** |

Zwei Eingriffe, beide ohne Funktionsverlust für die Crew: Kong startete
einen nginx-Worker **pro CPU-Kern** (acht auf dieser Maschine), jetzt einen
— das allein waren 533 MB. Und Studio + Meta liegen im Compose-Profil
`studio` und starten nur auf Abruf.

Dazu kommen Coolify selbst (~450 MB inkl. eigener Postgres/Redis) und das
Betriebssystem. **Für den Stack allein reichen 1 GB bequem**, mit Coolify
und Reserve sind 2 GB angenehm. Kommt die App als Container hinzu, plane
~400 MB extra.

Postgres braucht hier bewusst kein Tuning: 74 MB bei einer Datenbank, deren
Dump 78 KB groß ist. Wer an `shared_buffers` dreht, gewinnt nichts.

### Erreichbarkeit von außen

> ⚠️ **Der Reverse-Proxy des Servers ist nicht Teil dieses Runbooks.**
> Welche Domain auf welchen Container zeigt, entscheidet und konfiguriert
> ausschließlich der Server-Betreiber. Die compose-Datei veröffentlicht
> deshalb bewusst **keine** Host-Ports.

Von außen muss genau **ein** Container erreichbar sein:

| Container | Port | Domain (Vorschlag) |
|---|---|---|
| `kong` | 8000 | `sb.bordkasse.dieter.ms` |

Kong liefert darunter alles aus:

- `/rest/v1/…` → PostgREST
- `/auth/v1/…` → GoTrue (Magic-Link)
- `/realtime/v1/…` → Realtime (WebSocket)
- `/` → **Studio**, hinter Basic-Auth (`DASHBOARD_USERNAME` /
  `DASHBOARD_PASSWORD`)

Studio braucht also **keine eigene Domain** und steht nicht ungeschützt im
Netz. Das ist wichtig: wer in Studio hineinkommt, liest und schreibt jede
Zeile an RLS vorbei — inklusive Klarnamen und E-Mail-Adressen der Crew.
Setze ein langes, einmaliges `DASHBOARD_PASSWORD`, **wenn** du Studio nutzen
willst. Lässt du beide Werte leer (so liefert `.env.example` sie aus), verriegelt
`kong-entrypoint.sh` die Route mit einem Zufallspasswort: Studio ist dann
dauerhaft 401 — aber niemals offen, und der Rest des Gateways (Auth, REST,
Realtime) läuft unbehelligt weiter. Ein Hochkomma im Passwort lehnt der
Entrypoint ab, weil es die YAML-Struktur von `kong.yml` zerlegt.

Postgres wird **nicht** veröffentlicht. Migrationen, Dumps und Restores
laufen über `docker compose exec db …`.

---

## 2. Schritt 0 — Sicherung, bevor irgendetwas passiert

Nicht überspringen. Dieser Dump ist der Rückweg, wenn der Umzug schiefgeht.

Die Verbindungs-URL steht im Supabase-Dashboard unter *Project Settings →
Database → Connection string*. Der Client muss zur Server-Version passen
(Postgres 17).

```bash
export CLOUD_DB_URL='postgresql://postgres.<ref>:<passwort>@<host>:5432/postgres'
pg_dump "$CLOUD_DB_URL" --clean --if-exists --quote-all-identifiers \
  | gzip -9 > bordkasse-cloud-$(date +%F).sql.gz
```

Prüfen, dass die Sicherung wirklich etwas enthält:

```bash
gzip -t bordkasse-cloud-*.sql.gz && echo "Archiv intakt"
gzip -dc bordkasse-cloud-*.sql.gz | grep -c 'INSERT INTO\|COPY '
gzip -dc bordkasse-cloud-*.sql.gz | grep -q '"auth"."users"' && echo "auth-Schema enthalten"
```

> ⚠️ Der Dump enthält personenbezogene Daten der Crew (Klarnamen,
> E-Mail-Adressen). Nicht in Downloads liegen lassen, nicht per Mail
> verschicken, verschlüsselt ablegen.

**Zusätzlich einmal probeweise lokal wiederherstellen.** Ein Dump, den
niemand zurückgespielt hat, ist eine Vermutung, kein Backup.

---

## 3. Schritt 1 — Secrets erzeugen

```bash
cd webapp
node supabase/self-host/gen-keys.mjs
```

Das Skript gibt einen fertigen `.env`-Block aus: `POSTGRES_PASSWORD`,
`JWT_SECRET`, die daraus signierten `ANON_KEY` und `SERVICE_ROLE_KEY`,
`SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `PG_META_CRYPTO_KEY` und die
Studio-Zugangsdaten. Läuft offline mit Node-Bordmitteln — bewusst kein
Web-Generator, denn wer dein `JWT_SECRET` sieht, kann sich als
`service_role` ausgeben und an jeder RLS-Policy vorbeilesen.

Werte in die **Coolify-Env-Verwaltung** des Stacks eintragen, Vorlage und
Erklärung aller Variablen:
[`supabase/self-host/.env.example`](../webapp/supabase/self-host/.env.example).

> `JWT_SECRET` einmal festlegen und behalten. Ein Wechsel entwertet beide
> API-Keys und loggt alle Crewmitglieder aus.

Anzupassen sind außerdem die URLs: `API_EXTERNAL_URL` und
`SUPABASE_PUBLIC_URL` auf die Supabase-Domain, `SITE_URL` auf
`https://bordkasse.dieter.ms`, und die SMTP-Variablen auf denselben
Mailserver, den die App-Mails schon nutzen.

ℹ️ **`SITE_URL` wird doppelt genutzt.** GoTrue bekommt sie als
`GOTRUE_SITE_URL` (Basis für den Magic-Link), und `kong-entrypoint.sh` leitet
daraus die CORS-Allowlist ab. Für GoTrue ist ein Trailing-Slash harmlos, für
einen CORS-Vergleich gegen den `Origin`-Header wäre er tödlich — deshalb
**normalisiert** der Entrypoint den Wert (Kleinschreibung, ohne Pfad und
Trailing-Slash) in eine eigene Variable `CORS_ORIGIN` und schreibt eine
`HINWEIS:`-Zeile ins Log, wenn er dabei etwas ändern musste. Kong bricht nur ab,
wenn sich gar kein Origin ableiten lässt (leer, ohne Schema) oder der Wert
Zeichen enthält, die Kong als **Regex** statt als festen Origin behandeln würde
(IPv6-Literale, Umlaut-Domains, Komma-Listen — erlaubt sind `A-Z a-z 0-9 . : / -`).

---

## 3a. Coolify-Besonderheiten (aus dem echten Aufsetzen gelernt)

Drei Dinge, die beim ersten Durchlauf Zeit gekostet haben. Sie gelten für
Coolify **v4.2.0**; in neueren Versionen kann sich das ändern.

### „Preserve Repository During Deployment" ist Pflicht

Ohne diese Einstellung führt Coolify `docker compose up` in einem
**Wegwerf-Build-Container** aus (`executeInDocker(...)` im
`ApplicationDeploymentJob`). Das geklonte Repo liegt dann nicht auf dem
Host — der Docker-Daemon löst die relativen Bind-Mounts dieser
compose-Datei (`kong.yml`, `volumes/db/*.sql`) aber **auf dem Host** auf.
Docker legt an den fehlenden Quellpfaden leere **Verzeichnisse** an, und ein
Verzeichnis auf einen Datei-Pfad zu mounten schlägt fehl. Der Deploy bricht
dann nach etwa einer Minute ab.

Mit aktivierter Option kopiert Coolify das Repo auf den Server und startet
dort direkt mit `--project-directory`, womit die Pfade stimmen.

```bash
curl -X PATCH "https://<coolify>/api/v1/applications/<APP_UUID>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"is_preserve_repository_enabled":true}'
```

### Das General-Formular kann in v4.2.0 nicht gespeichert werden

Jeder Speicherversuch im Tab *Configuration → General* einer
Docker-Compose-Anwendung endet mit:

```
sslipDomainWarning(): Argument #1 ($domains) must be of type string, null given
```

Ursache: `General.php` ruft `sslipDomainWarning($this->fqdn)` auf; bei
Compose-Anwendungen gibt es kein anwendungsweites `fqdn`, der Wert ist
`null`, und die Funktion war in v4.2.0 nicht nullable. Im `main`-Branch ist
das behoben (`?string`), in v4.2.0 noch nicht.

Domains deshalb über die API setzen — für Compose-Apps ausdrücklich über
`docker_compose_domains`, nicht über `domains`:

```bash
curl -X PATCH "https://<coolify>/api/v1/applications/<APP_UUID>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"docker_compose_domains":[{"name":"kong","domain":"https://sb.bordkasse.dieter.ms"}]}'
```

Vorteil gegenüber der UI: die API validiert den Wert, ein versehentliches
führendes Leerzeichen fliegt sofort auf statt still eine kaputte
Traefik-Regel zu erzeugen.

### API-Token: Berechtigungen bewusst wählen

`read` + `write` genügen für Konfiguration. Bewusst **nicht** vergeben:

- `root` — Vollzugriff auf die ganze Instanz (bei geteilten Servern tabu)
- `read:sensitive` — nötig, um Env-**Werte** über die API zu lesen; ohne das
  liefert die API die Schlüssel ohne Werte, was für Konfigurationsarbeit
  reicht und Secrets nicht unnötig herumträgt
- `deploy` — nur, wenn Deployments per API ausgelöst werden sollen; sonst
  bleibt der Deploy-Knopf in der UI

Setup-Token kurz befristen (7 Tage) und danach widerrufen.

## 4. Schritt 2 — Stack starten

```bash
cd webapp/supabase/self-host
docker compose up -d
docker compose ps          # alle Container "healthy"?
```

Erst weitermachen, wenn `db`, `auth`, `rest` und `studio` gesund sind.
`kong` startet absichtlich zuletzt (es wartet auf die drei).

Bei Problemen:

```bash
docker compose logs -f auth      # z. B. SMTP-Fehler
docker compose logs -f db
```

---

## 5. Schritt 3 — Schema anlegen (47 Migrationen)

Die Migrationen laufen der Reihe nach direkt in den Container. Postgres ist
nicht von außen erreichbar, deshalb über `exec` statt `supabase db push`:

```bash
cd webapp
for f in supabase/migrations/*.sql; do
  echo "→ $f"
  docker exec -i bordkasse-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" || {
    echo "ABBRUCH bei $f"; break; }
done
```

`ON_ERROR_STOP=1` ist wichtig — ohne das rauscht psql über Fehler hinweg
und hinterlässt ein halbes Schema, das erst Wochen später auffällt.

Danach die Migrationen registrieren, damit ein späteres
`supabase db push` sie nicht erneut anwenden will:

```bash
docker exec -i bordkasse-db psql -U postgres -d postgres <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version TEXT PRIMARY KEY,
  statements TEXT[],
  name TEXT
);
SQL

for f in supabase/migrations/*.sql; do
  v=$(basename "$f" .sql)
  docker exec -i bordkasse-db psql -U postgres -d postgres -c \
    "INSERT INTO supabase_migrations.schema_migrations (version, name)
     VALUES ('${v%%_*}', '$v') ON CONFLICT DO NOTHING;"
done
```

Gegenprobe:

```bash
docker exec -i bordkasse-db psql -U postgres -d postgres -c \
  "SELECT count(*) AS tabellen FROM information_schema.tables WHERE table_schema='public';"
docker exec -i bordkasse-db psql -U postgres -d postgres -c \
  "SELECT count(*) AS views FROM pg_views WHERE schemaname='public';"
```

Es müssen **6 Views** existieren (`v_balances`, `v_transaction_shares`,
`v_balances_bordkasse_only`, `v_prepayment_payments`,
`v_prepayment_pending`, `v_trip_members_with_days`).

---

## 6. Schritt 4 — Daten importieren

### Reihenfolge ist zwingend: erst `auth`, dann `public`

`persons.auth_user_id` ist ein Fremdschlüssel auf `auth.users(id)`
(Migration `0001_init.sql`). Kommen die App-Daten zuerst, weist die
Datenbank jede Person mit Login zurück.

### 4a. Auth-Daten

Nur die beiden Tabellen, die die Logins tragen. Der Rest des
`auth`-Schemas gehört GoTrue und wird von der Migration selbst verwaltet:

```bash
pg_dump "$CLOUD_DB_URL" --data-only --quote-all-identifiers \
  --table='auth.users' --table='auth.identities' \
  > data-auth.sql

docker exec -i bordkasse-db psql -v ON_ERROR_STOP=1 --single-transaction \
  -U postgres -d postgres < data-auth.sql
```

> **Sessions kommen nicht mit.** Bestehende Anmeldungen sind an das alte
> JWT-Secret gebunden und mit dem neuen ohnehin ungültig. Alle
> Crewmitglieder müssen sich **einmal** neu per Magic-Link einloggen. Das
> ist der richtige Moment für den Umzug: außerhalb eines Törns.

**Falls dieser Import an Spalten scheitert** (Cloud-GoTrue und
selbst gehostetes GoTrue können sich in der `auth.users`-Struktur
unterscheiden), gibt es einen sauberen Ausweg — die App kann Personen
anhand der E-Mail neu verknüpfen:

```bash
# 1. Auth-Daten NICHT importieren.
# 2. Nach dem public-Import die alten Verknüpfungen lösen:
docker exec -i bordkasse-db psql -U postgres -d postgres -c \
  "UPDATE persons SET auth_user_id = NULL;"
```

Beim nächsten Login findet `lib/auth/get-current-person.ts` die Person
über ihre E-Mail und verknüpft sie mit dem neuen Auth-User (Ghost-Pfad).

> ⚠️ Das `UPDATE` ist **nicht optional**, wenn die Auth-Daten fehlen: der
> Wiederverknüpfungs-Pfad greift ausschließlich bei
> `auth_user_id IS NULL`. Bleibt eine verwaiste alte ID stehen, legt die
> App beim Login eine **zweite** Person an — das Crewmitglied verliert
> seine Törn-Mitgliedschaften und Buchungen erscheinen unter einem
> Fremden. Entweder Auth-Daten importieren **oder** nullen, niemals keins
> von beidem.

> ⚠️ **Grenze des Fallbacks:** Die Wiederverknüpfung läuft über
> `persons_private.email`. Eine Person **ohne** hinterlegte E-Mail (reine
> Ghost-Crew, die der Skipper nur mit Namen angelegt hat) kann so nie
> wieder verknüpft werden. Das ist unkritisch, solange sie sich nie
> einloggt — genau dafür sind Ghosts da. Loggt sie sich später doch ein
> (weil der Skipper eine Adresse nachträgt), entsteht eine Zweit-Person und
> die Zuordnung muss manuell aufgeräumt werden. Der Import der Auth-Daten
> ist deshalb der Weg mit weniger Überraschungen.

### 4b. App-Daten

```bash
pg_dump "$CLOUD_DB_URL" --data-only --schema=public \
  --quote-all-identifiers --disable-triggers \
  > data-public.sql

docker exec -i bordkasse-db psql -v ON_ERROR_STOP=1 --single-transaction \
  -U postgres -d postgres < data-public.sql
```

`--disable-triggers` schaltet während des Imports die
Fremdschlüssel-Prüfung aus, damit die Tabellen-Reihenfolge im Dump keine
Rolle spielt.

`--single-transaction` ist wichtig: ohne das bricht ein Fehler mitten im
Import ab und hinterlässt einen **halb** importierten Bestand — die
Zeilenzählung unten zeigt dann, *dass* etwas fehlt, aber nicht *wo*. Mit
der Klammer ist der Import entweder ganz drin oder gar nicht, und du kannst
die Ursache beheben und einfach neu starten.

Sollte ein Import doch einmal ohne diese Klammer teilweise durchgelaufen
sein: **nicht** ein zweites Mal darüberspielen (das erzeugt Duplikate oder
Schlüsselkonflikte), sondern die betroffenen Tabellen leeren und von vorn:

```bash
docker exec -i bordkasse-db psql -U postgres -d postgres -c \
  "TRUNCATE persons, trips, trip_members, transactions,
            transaction_participants, settled_debts CASCADE;"
```

### 4c. Zeilen zählen und vergleichen

Auf **beiden** Seiten ausführen und die Zahlen gegenüberstellen:

```sql
SELECT 'persons' t, count(*) FROM persons
UNION ALL SELECT 'trips', count(*) FROM trips
UNION ALL SELECT 'trip_members', count(*) FROM trip_members
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'transaction_participants', count(*) FROM transaction_participants
UNION ALL SELECT 'prepayment_obligations', count(*) FROM prepayment_obligations
UNION ALL SELECT 'settled_debts', count(*) FROM settled_debts
UNION ALL SELECT 'auth.users', count(*) FROM auth.users
ORDER BY 1;
```

Und die inhaltliche Kernprobe — **die Bilanz jedes Törns muss auf 0
aufgehen**, sonst ist beim Import etwas verloren gegangen:

```sql
SELECT trip_id, round(sum(balance)::numeric, 2) AS summe
FROM v_balances GROUP BY trip_id HAVING round(sum(balance)::numeric, 2) <> 0;
```

Leeres Ergebnis = alles in Ordnung.

---

## 7. Schritt 5 — App auf den neuen Stack zeigen lassen

In den Env-Vars der App-Ressource ändern (damals noch bei Vercel, seit dem
Cutover in Coolify — Abschnitt 9a):

| Variable | neuer Wert |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://sb.bordkasse.dieter.ms` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` aus Schritt 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` aus Schritt 1 |

Danach **neu deployen** — `NEXT_PUBLIC_*`-Variablen werden zur Build-Zeit
in den Client-Bundle eingebacken, ein Env-Wechsel allein wirkt nicht.

Die CSP zieht den erlaubten Host automatisch aus
`NEXT_PUBLIC_SUPABASE_URL` (`supabaseConnectSrc()` in `next.config.ts`) —
inklusive `wss://` für Realtime. Vor dieser Änderung stand dort fest
`*.supabase.co`; ohne die Anpassung hätte der Browser jede Verbindung zur
eigenen Datenbank blockiert, und zwar still: Seiten rendern normal, nur
Live-Updates bleiben aus.

---

## 8. Schritt 6 — Verifikation

Nicht abhaken, ohne es wirklich ausprobiert zu haben:

- [ ] **Magic-Link:** Login anfordern, Mail kommt an, Link führt zum
      eingeloggten Zustand.
- [ ] **Die Mail ist gebrandet** (Logo, Marineblau). Kommt eine schmucklose
      Standard-Mail, hat GoTrue das Template nicht erreicht und ist still
      auf sein Default zurückgefallen — siehe Fallen unten.
- [ ] **Neu-Einladung** (eigener Testfall, nicht dasselbe wie oben!): eine
      Adresse als Crew einladen, die noch **keinen** Auth-User hat. Die Mail
      muss gebrandet sein **und** der Link in den eingeloggten Zustand
      führen. Dieser Pfad läuft über `GOTRUE_MAILER_AUTOCONFIRM`; steht das
      falsch, verschickt GoTrue statt des Magic-Links eine englische
      Signup-Bestätigung mit einer URL, die die App nicht verarbeitet — und
      zwar **nur** für Neu-Einladungen, während bestehende Crew nichts
      merkt. Ohne diesen Test fällt es erst beim nächsten Törn auf.
- [ ] **Törn öffnen:** Buchungen, Bilanz, Schulden zeigen die alten Daten.
- [ ] **Bilanz-Summe je Törn = 0.**
- [ ] **Realtime:** Törn in zwei Browsern öffnen, in einem eine Buchung
      anlegen — der andere aktualisiert sich. In der Konsole darf **keine**
      CSP-Meldung zu `connect-src` stehen.
- [ ] **Schreiben:** Buchung anlegen, ändern, löschen.
- [ ] **Mails der App:** Abrechnung verschicken (Testtörn).
- [ ] **Studio:** erst `docker compose --profile studio up -d studio` starten,
      dann erreichbar und fragt nach Basic-Auth. Ohne das Profil fragt Kong das
      Basic-Auth zwar ab, liefert danach aber erwartungsgemäß einen 502.
- [ ] **Crons:** beide Endpunkte antworten mit gültigem `CRON_SECRET`
      `200`, ohne `401`.
- [ ] **Backup:** Scheduled Task angelegt, einmal manuell laufen lassen
      (`OK: /backups/…`), Dump ausgelagert und in eine frische Instanz
      zurückgespielt.

---

## 9. Backup

[`supabase/self-host/backup.sh`](../webapp/supabase/self-host/backup.sh)
läuft **innerhalb des `db`-Containers**. `docker-compose.yml` mountet es
nach `/usr/local/bin/bordkasse-backup` und legt das Named Volume
`db-backups` unter `/backups` ab.

Warum im Container und nicht auf dem Host: Coolifys Scheduled Tasks führen
ihren Befehl in einem Container des Stacks aus. Dort gibt es keinen
Docker-Socket, ein Skript mit `docker exec` wäre also gar nicht
einrichtbar. Die Alternative — System-Cron auf dem Host — läge außerhalb
des Repos und außerhalb dessen, was auf einer fremden Maschine
eingerichtet werden sollte.

**Coolify Scheduled Task** anlegen (Container `db`, täglich `0 0 * * *`):

```bash
bash /usr/local/bin/bordkasse-backup
```

Das Feld **Container name** muss `db` enthalten — bleibt es leer, landet der
Befehl in einem beliebigen Container des Stacks, wo es weder das Skript noch
`pg_dump` gibt. Die Ausgabe jedes Laufs steht auf der Task-Seite unter
„Recent executions" (Eintrag anklicken). Coolify setzt ein **Timeout von
300 s** — für die heutige Datenmenge weit ausreichend (ein Lauf dauert ~2 s),
aber die Stelle, die bei stark gewachsener Datenbank still zuschlägt.

Manuell vom Host aus — Container-Namen dynamisch ermitteln, Coolify
ignoriert `container_name`:

```bash
# <app-uuid> = UUID der Coolify-Anwendung.
# `--filter name=` matcht als Teilstring: während eines Redeploys existiert
# der alte Container kurz noch, dann liefert der Filter zwei Zeilen und
# `docker exec` bricht kryptisch ab. Daher `head -n1`.
docker exec "$(docker ps --filter name=db-<app-uuid> --format '{{.Names}}' | head -n1)" bash /usr/local/bin/bordkasse-backup
```

Das Skript dumpt als `supabase_admin` (der Superuser des Images — als
`postgres` fehlten still die `auth`-Tabellen, die `supabase_auth_admin`
gehören), sichert also `public` **und** `auth`, prüft die Integrität des
Archivs, verweigert offensichtlich abgebrochene Dumps und räumt Dateien
älter als 30 Tage auf (erst nach erfolgreicher Prüfung — ein
fehlgeschlagener Lauf löscht nie die letzten guten Backups).

### Auslagern (eingerichtet, Stand 2026-08-05)

Der **Server-Betreiber** zieht das Named Volume `db-backups` mit seinem
eigenen Backup-Werkzeug **vom Server weg**, verschlüsselt und
zugriffsgeschützt. Für Hetzner besteht ein AV-Vertrag, weitere
Cloud-Dienste sind nicht beteiligt.

**Die Uhrzeiten sind aufeinander abgestimmt:**

| | |
|---|---|
| 00:00 | unser Dump (`bordkasse-backup`, Coolify Scheduled Task) |
| 02:00 | sein Sweep holt das Volume vom Server |

Deshalb `0 0 * * *` und nicht `0 2 * * *`: so wandert jede Nacht der
frische Stand nach außen. **Wer die Zeit verschiebt, muss das mit ihm
klären** — sonst geht nachts der Dump des Vortags mit, ohne dass es
auffällt.

Nicht das Volume `db-data` (PGDATA) sichern: ein Dateisystem-Backup einer
laufenden Postgres-Instanz ist nicht konsistent. In `db-backups` liegen
fertige, bereits inhaltlich geprüfte Dumps.

> Historie: Es gab hier zeitweise ein Skript `pull-backup.sh`, das die
> Dumps per `ssh` auf den Rechner des Skippers zog. Entfernt, weil dieser
> SSH-Zugang nicht existiert (Port 22 ist von außen nicht erreichbar). Ein
> Skript, das wie eine funktionierende Absicherung aussieht, aber nie
> läuft, ist schlimmer als keins.

**Das musst du selbst ergänzen:**

1. **Restore testen.** Am besten quartalsweise: Dump zurückspielen und die
   Bilanz-Summenprobe aus Schritt 4c fahren. Ein nie getesteter Restore ist
   kein Restore.

   ```bash
   gzip -dc bordkasse_<stamp>.sql.gz | docker exec -i <db-container> \
     psql -U supabase_admin -d postgres
   ```

   Im Ernstfall (Restore in den **laufenden** Stack, nicht in eine frische
   Instanz) vorher `auth`, `rest` und `realtime` stoppen. Deren offene
   Verbindungen blockieren sonst die `DROP`s des `--clean`-Dumps, und die
   Dienste laufen währenddessen gegen eine halb abgeräumte Datenbank.

   Wichtig dabei: Der Dump enthält **keine Rollen** (`anon`,
   `authenticated`, `service_role`, `supabase_auth_admin`, `authenticator`).
   Die bringt das `supabase/postgres`-Image über
   `volumes/db/roles.sql` mit. Der Restore gehört deshalb in eine **frisch
   hochgezogene Instanz dieses Stacks**, nicht in ein nacktes Postgres —
   dort scheitert er an fehlenden Rollen und Rechten.

Mit dem Umzug wandert die Verantwortung für Backups und Postgres-Updates
von Supabase zu euch. Das ist der Preis dafür, dass nichts mehr einschläft.

---

## 9a. Schritt 7 — App von Vercel nach Coolify

Der technische Teil liegt im Repo: [`webapp/Dockerfile`](../webapp/Dockerfile)
(Next.js `standalone`, non-root, Healthcheck) und `output: "standalone"` in
`next.config.ts`. Beides war auf Vercel folgenlos und lag deshalb schon fertig
bereit, bevor umgeschaltet wurde.

### Neue Coolify-Anwendung

| Feld | Wert |
|---|---|
| Build Pack | `Dockerfile` |
| Base Directory | `/webapp` |
| Dockerfile Location | `/Dockerfile` |
| Port | `3000` |

⚠️ **Falle „Dockerfile Location" (echter Fund beim ersten Deploy):** Coolify
hängt den Wert von „Dockerfile Location" an „Base Directory" — der Pfad ist
relativ zum Base Directory, NICHT zum Repo-Root. `/webapp/Dockerfile` (Repo-
Root-relativ, naheliegend) ergibt zusammen mit `Base Directory=/webapp` den
Pfad `webapp/webapp/Dockerfile` und der Build bricht sofort mit `lstat
/artifacts/.../webapp/webapp: no such file or directory` ab, noch bevor
irgendein Build-Log erscheint. Richtig ist `/Dockerfile`.

**„Consistent Container Names" / „Custom Container Name" (Advanced-Tab):**
für einen stabilen, redeploy-festen Namen (z. B. damit ein anderer Coolify-
Service die App über den Docker-Namen ansprechen kann) im Advanced-Tab
„Custom Container Name" setzen (hier: `bordkasse-app`). Ohne das vergibt
Coolify bei jedem Deploy einen neuen Namen mit Zeitstempel-Suffix. Nebeneffekt:
„Custom internal name is set, rolling update is not supported" — Redeploys
stoppen den alten Container erst, bevor der neue startet (kurze Downtime
statt nahtlosem Wechsel; für eine Crew-App ohne Dauerlast unkritisch).

### Env-Vars

**Jede `NEXT_PUBLIC_*`-Variable** muss als **Build Variable** markiert sein,
nicht nur als Laufzeit-Wert:

| Variable | |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Pflicht |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Pflicht |
| `NEXT_PUBLIC_APP_ORIGIN` | Pflicht (Magic-Links) |
| `NEXT_PUBLIC_SITE_URL` | optional, hat Vorrang vor `APP_ORIGIN` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | optional, ohne ihn kein Web-Push |

Next ersetzt **jede** `process.env.NEXT_PUBLIC_*`-Referenz statisch beim
Build — auch in Server-Code. Ein Wert, der nur im Container-Environment
steht, kommt danach nirgends mehr an; das Environment nachträglich zu
ändern wirkt ohne Neubau nicht.

Was still bricht, wenn man das übersieht:

- **`SUPABASE_URL`:** `next.config.ts` leitet den `connect-src`-Teil der CSP
  daraus ab. Fehlt sie, lädt die App — aber der Browser blockt jeden
  Datenzugriff und Realtime an der CSP.
- **`APP_ORIGIN`/`SITE_URL`:** `lib/auth/origin.ts` baut daraus die
  Magic-Link-URL. Fehlen beide, stürzen Crew-Einladungen ab — genau der
  Vorfall, der in Produktion schon einmal passiert ist.
- **`VAPID_PUBLIC_KEY`:** der Push-Knopf scheitert clientseitig ohne
  aussagekräftige Meldung.

Das Dockerfile bricht bei den drei Pflicht-Werten absichtlich mit einer
klaren Meldung ab, statt ein Image zu erzeugen, das erst im Browser hängt.

Alles Übrige sind reine Laufzeit-Werte und gehören **nicht** in Build-Args
(sonst liegen sie in den Image-Layern): `SUPABASE_SERVICE_ROLE_KEY`,
`ADMIN_EMAILS`, `CRON_SECRET`, `SMTP_*`, `MAIL_FROM`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Vollständige Liste in CLAUDE.md,
Abschnitt „Deploy".

⚠️ **Coolify setzt „Available at Buildtime" standardmäßig für JEDE neu
angelegte Variable** — beim ersten echten Setup stand der Haken bei
ausnahmslos allen Variablen, inklusive `SUPABASE_SERVICE_ROLE_KEY` und
`SMTP_PASS`. Nach dem Anlegen jeder Nicht-`NEXT_PUBLIC_*`-Variable **aktiv
kontrollieren und den Buildtime-Haken entfernen** (Runtime bleibt an) — sowohl
im „Production"- als auch im „Preview Deployments"-Abschnitt, beide werden
unabhängig verwaltet.

⚠️ **`NEXT_PUBLIC_*` sind seit dem Auth-Guard sicherheitsrelevant, nicht mehr
nur kosmetisch.** Next backt sie beim Build ein — auch in Server-Code. Aus
`NEXT_PUBLIC_SITE_URL`/`NEXT_PUBLIC_APP_ORIGIN` entsteht die Allowlist, gegen
die `requestMayRedeemToken` (`lib/auth/origin.ts`) entscheidet, ob ein
Magic-Link überhaupt eingelöst werden darf. Früher führte ein falscher Wert nur
zu falschen Links; heute kann er **jeden Login blockieren** (`?auth_error=untrusted_host`).
Daraus folgt:

- Eine Domain-Änderung braucht einen **Rebuild**, kein Restart — ein reiner
  Runtime-Wechsel wirkt nicht, und die Allowlist trägt weiter die alte Domain.
- Beide Variablen dürfen abweichen (beide stehen auf der Allowlist), sollten es
  aber nicht: für Mail-Links gewinnt `SITE_URL`.
- **Notfall-Ausweg, falls nach einem Deploy niemand mehr einloggen kann:** beide
  Variablen aus den **Build**-Args entfernen und neu bauen. Bei leerer Allowlist
  schaltet der Guard bewusst auf fail-open, der Login funktioniert wieder wie
  vorher. Das ist schneller als ein Revert samt Rebuild.

⚠️ **`??` vs. leerer String:** in Vercel ist eine nicht gesetzte Env-Var
`undefined`; im Docker-Build wird ein nicht übergebener `ARG` beim `ENV`-
Befehl im Dockerfile zu einem **leeren String** `""`. Code-Stellen, die
`process.env.A ?? process.env.B` fallback-verketten (`??` reagiert nur auf
`null`/`undefined`, nicht auf `""`), brechen deshalb im Docker-Deploy auf eine
Art, die auf Vercel nie auftritt — siehe `lib/auth/origin.ts` (gefixt, PR
#239). Bei künftigen Env-Fallback-Ketten `||` statt `??` verwenden, wenn eine
der Variablen aus einem Docker-`ARG` ohne Default stammen könnte.

### Die beiden Crons

`vercel.json` ist mit dem Cutover entfallen (es trug neben den beiden Crons
auch `regions: ["fra1"]`). Ersatz sind zwei Coolify Scheduled Tasks auf der
App-Ressource — „Container name" bleibt **leer**, dann läuft der Befehl im
App-Container (verifiziert: ein Task mit leerem Feld führt erfolgreich aus):

| Name | Frequenz | Command |
|---|---|---|
| `purge-node` | `0 1 * * *` | `node -e "fetch('http://127.0.0.1:3000/api/cron/purge',{headers:{Authorization:'Bearer '+process.env.CRON_SECRET}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.log(e);process.exit(1)})"` |
| `prepayment-reminders-node` | `0 7 * * *` | dasselbe Kommando, nur `/api/cron/purge` → `/api/cron/prepayment-reminders` (der Pfad kommt genau einmal vor; ergibt 250 Zeichen — siehe Längenlimit unten) |

⚠️ **`curl` gibt es im App-Container NICHT** (echter Fund, empirisch geprüft
über einen temporären Scheduled Task mit
`sh -c "command -v curl || echo NO_CURL; command -v wget || echo NO_WGET; node -v"`
→ Ausgabe `NO_CURL`, `/usr/bin/wget`, `v22.23.2`). Das Image ist
`node:22-alpine`; Alpine bringt kein curl mit, und das Dockerfile installiert
keins — genau deshalb nutzt schon der `HEALTHCHECK` ein `node -e "fetch(…)"`.
Die ursprünglich hier dokumentierten `curl`-Kommandos wären beim ersten Lauf
still mit `curl: not found` (Exit 127) gescheitert: DSGVO-Purge und
Anzahlungs-Erinnerungen hätten nie stattgefunden. Verfügbar sind `node` und
BusyBox-`wget` (`/usr/bin/wget`) — `wget -qO- --header=…` wäre die kürzere
Alternative, `node -e` ist die sichere, weil die App ohnehin Node ist.

Warum diese Form:

- `process.env.CRON_SECRET` statt `$CRON_SECRET` — keine Shell-Quoting-Fallen,
  falls das Secret Sonderzeichen enthält.
- `process.exit(r.ok?0:1)` ist das Gegenstück zu `curl -f`: ohne expliziten
  Exit-Code meldet der Task auch bei 401/500 grün, obwohl nichts passiert ist.
- `127.0.0.1` statt `localhost` — der Server bindet auf IPv4 `0.0.0.0`
  (`HOSTNAME` im Dockerfile). Node ≥ 20 würde ein `localhost` per Happy
  Eyeballs zwar von `::1` auf IPv4 zurückfallen lassen, aber deterministisch
  IPv4 ohne diesen Umweg ist sauberer — der `HEALTHCHECK` macht es genauso.
- Status **und** Body werden geloggt, damit unter „Recent executions" sichtbar
  ist, was der Lauf getan hat.

⚠️ **Längenlimit der Coolify-API:** ein `command` über ~255 Zeichen lässt
`POST …/scheduled-tasks` mit einer nackten HTTP-500-HTML-Seite antworten (kein
Validierungsfehler). Die Kommandos oben liegen bei 235 bzw. 250 Zeichen —
beim Erweitern also kürzen, nicht anhängen.

**Zu den Zeiten:** Der Reminder-Lauf (07:00) stammt unverändert aus der alten
`vercel.json`; der Purge lief anfangs ebenfalls dort (03:00) und wurde am
06.08.2026 auf **01:00** vorgezogen.

Entscheidend ist nur eine Reihenfolge: **der Backup-Dump (00:00) muss VOR dem
Purge liegen.** Sonst löscht der Purge Daten, die in der Sicherung derselben
Nacht noch fehlen — und der Rückweg für ein versehentliches „Sofort löschen"
wäre einen Tag alt. Mit 01:00 ist der Abstand zum Dump kleiner als vorher, die
Reihenfolge bleibt aber gewahrt. Das Auslagern der Sicherung (02:00) ist davon
unabhängig: es kopiert den 00:00-Dump, also in beiden Fällen den Stand VOR dem
Purge.

Coolify zeigt die Laufzeiten unter „Recent executions" in UTC an.

### Beim Umschalten (✅ durchgeführt am 2026-08-05)

1. Domain `bordkasse.dieter.ms` umhängen — **macht der Server-Betreiber.**
   DNS: alten `CNAME` auf `cname.vercel-dns.com` löschen, `A`-Record auf die
   Server-IP anlegen (A und CNAME können für denselben Namen nicht
   koexistieren). Zusätzlich in der Coolify-App-Ressource selbst im Feld
   „Domains" die Custom-Domain eintragen (`https://bordkasse.dieter.ms`) und
   redeployen — **sonst bricht der TLS-Handshake ab**, obwohl DNS längst
   korrekt zeigt: Traefik kennt die Domain nicht und kann kein
   Let's-Encrypt-Zertifikat dafür ausstellen (Symptom: `curl` liefert
   `LibreSSL: error:1404B438:SSL routines:ST_CONNECT:tlsv1 alert internal
   error`, HTTP-Status `000`). Nach dem Redeploy stellt Coolify das
   Zertifikat automatisch aus.

   Nach dem DNS-Wechsel kann es bei Endnutzern **bis zu einer Stunde**
   (altes TTL) dauern, bis ihr lokaler Resolver den neuen Wert zieht — bei
   öffentlichen Resolvern (Cloudflare `1.1.1.1`, Google `8.8.8.8`) und dem
   autoritativen Nameserver selbst ist der neue Wert sofort sichtbar. Zum
   Verifizieren unabhängig vom eigenen DNS-Cache: `curl --resolve
   bordkasse.dieter.ms:443:<server-ip> https://bordkasse.dieter.ms/`, oder
   testweise einen Eintrag in `/etc/hosts` setzen.
2. `MAILER_TEMPLATE_MAGIC_LINK` im Supabase-Stack auf den internen
   Docker-Namen der App zeigen lassen
   (`http://<app-container>:3000/email/magic-link.html`). Danach eine echte
   Testmail ansehen: GoTrue fällt bei nicht erreichbarer URL **still** auf
   sein unbrandetes Default zurück.

   ⚠️ **Getestet, funktioniert (noch) nicht:** im ersten echten Setup (App +
   Supabase-Stack als zwei getrennte Coolify-Ressourcen im selben Projekt)
   war der interne Name trotz „Custom Container Name" für GoTrue NICHT
   erreichbar — die Mail kam mit GoTrues eingebautem Default-Template an
   (Symptom: Link zeigt auf `<API_EXTERNAL_URL>/auth/confirm?token=pkce_…`
   statt auf die App-Domain, landet im Kong-Catch-all/Studio-Basic-Auth statt
   in der App). Vermutlich liegen Dockerfile-Apps und Docker-Compose-Stacks
   in Coolify nicht automatisch im selben Docker-Netzwerk — noch nicht
   abschließend untersucht (kein Terminal-/Exec-Zugriff in dieser Session).
   **Workaround, der nachweislich funktioniert:** `MAILER_TEMPLATE_MAGIC_LINK`
   auf der öffentlichen URL belassen (`https://bordkasse.dieter.ms/email/
   magic-link.html`) — die zeigt nach Schritt 1 ja bereits auf den neuen
   App-Container. Die interne-Docker-Name-Optimierung ist ohnehin nur
   „optional" (unabhängig von DNS/TLS) und kann bei Gelegenheit separat
   untersucht werden (z. B. beide Ressourcen explizit auf ein gemeinsames
   Coolify-Netzwerk legen).
3. `webapp/vercel.json` entfernen und das Vercel-Projekt abschalten. ✅ erledigt
   — die beiden Crons daraus leben jetzt als Coolify Scheduled Tasks (siehe
   „Die beiden Crons"), die `fra1`-Region entfällt mit dem eigenen Server.
4. **Datenschutzerklärung** (`app/datenschutz/page.tsx`): Vercel Inc. und
   Supabase Inc. fallen als Auftragsverarbeiter weg, der Betreiber des
   Servers kommt hinzu (mit ladungsfähiger Identität), Hetzner als
   Unterauftragsverarbeiter. Rechtlich der empfindlichste Schritt — und
   getrennt davon zu klären, dass der Betreiber damit Auftragsverarbeiter
   für die Daten der Crew wird.

---

## 10. Betrieb

**Updates:** Image-Versionen in `docker-compose.yml` sind gepinnt. Zum
Aktualisieren dort die Version hochziehen, committen und die Ressource **in
Coolify redeployen** (Coolify fährt selbst `docker compose up -d`; „Preserve
Repository During Deployment" muss gesetzt sein, siehe Abschnitt 3a). Vorher
Backup.

⚠️ **Neue `environment:`-Einträge brauchen ein Recreate, kein Restart.**
`docker compose restart` startet den bestehenden Container mit seiner alten
Konfiguration neu — eine frisch ergänzte Variable (z. B. `SITE_URL` beim
Kong-Service) fehlt darin weiterhin. Nur `up -d` bzw. ein Coolify-Redeploy der
**Supabase-Compose-Ressource** (eine andere Ressource als die App!) legt den
Container neu an. Bewusst kein `:latest` — sonst ändert sich die Infrastruktur beim
nächsten Neustart unbemerkt.

> ⚠️ **`docker compose down -v` niemals blind ausführen.** Das `-v` löscht
> die Named Volumes — inklusive `db-data`, also des gesamten
> Datenbestands. Zum Neustarten genügt `docker compose down` (ohne `-v`)
> oder `docker compose restart`.

Der Datenbestand liegt bewusst in einem **Named Volume** (`db-data`), nicht
als Bind-Mount im Projektverzeichnis: ein Coolify-Redeploy, der frisch
klont oder `git clean -xfd` fährt, hätte einen Ordner im Checkout sonst
mitgenommen — Postgres wäre mit leerer Datenbank gestartet und die App
hätte ausgesehen, als wären alle Törns gelöscht.

**Logs:** über Coolify oder `docker compose logs -f <service>`.

**Postgres-Konsole:** auf dem Coolify-Stack trägt der Container NICHT den Namen
aus `container_name` (siehe Abschnitt 8) — Namen deshalb dynamisch ermitteln:

```bash
DB=$(docker ps --filter name=db-<app-uuid> --format '{{.Names}}' | head -n1)
docker exec -it "$DB" psql -U postgres -d postgres
```

**RAM prüfen:** `docker stats --no-stream`

---

## 11. Rollback

Solange Supabase Cloud noch existiert, ist der Rückweg kurz: die drei
Env-Vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) in der Coolify-App-Ressource auf die alten Werte
zurücksetzen und **neu bauen** — die beiden `NEXT_PUBLIC_*` sind
Build-Variablen, ein Restart allein wirkt nicht. Ein Rückweg nach Vercel
existiert nicht mehr (Projekt gelöscht), der Rollback betrifft nur die
Datenbank. Das Cloud-Projekt erst löschen, wenn der neue Stack einen echten
Törn überlebt hat.

Wurde in der Cloud bereits gelöscht: Sicherung aus Schritt 0 einspielen.

---

## 12. Bekannte Fallen

**Magic-Link-Mail kommt unbrandet an.** Selbst gehostetes GoTrue liest
Templates **nur per HTTP-URL**, nicht aus gemounteten Dateien. Ist
`MAILER_TEMPLATE_MAGIC_LINK` nicht erreichbar, fällt GoTrue **still** auf
sein Default zurück — kein Fehler im Log. Prüfen:

```bash
AUTH=$(docker ps --filter name=auth-<app-uuid> --format '{{.Names}}' | head -n1)
docker exec "$AUTH" wget -qO- "$MAILER_TEMPLATE_MAGIC_LINK" | head -5
```

Häufigste Ursache: die Ausnahme für `email/` im `config.matcher` von
`proxy.ts` fehlt, dann antwortet die App mit `307` auf `/login`.

**`realtime`, `rest` und `auth` in einer Neustart-Schleife, `db` meldet aber
„healthy".** Im `db`-Log steht dann:

```
role "supabase_admin" does not exist
```

Ursache: `POSTGRES_USER` wurde im `db`-Service gesetzt. Das Image bringt
`POSTGRES_USER=supabase_admin` mit; `initdb` erzeugt daraus den Superuser,
und genau als diese Rolle verbindet sich anschließend das Init-Skript des
Images (`/docker-entrypoint-initdb.d/migrate.sh`), das **alle** Supabase-
Rollen und Schemata anlegt. Ein Override bricht das beim ersten Befehl ab.

Tückisch daran: das passiert **nur beim allerersten Start**. Die Variable
danach zu entfernen genügt nicht — das Datenverzeichnis bleibt für immer
ohne Rollen. Deshalb: Variable entfernen, Stack stoppen, `db-data` **und**
`db-config` löschen, neu deployen.

```bash
docker volume rm <projekt>_db-data <projekt>_db-config
```

Bei Coolify ist `<projekt>` die Anwendungs-UUID. Kein `docker volume prune`
auf geteilten Servern — das trifft auch fremde Dienste.

**Alles antwortet mit 401.** `ANON_KEY`/`SERVICE_ROLE_KEY` passen nicht zu
`JWT_SECRET`. Beide müssen aus demselben Lauf von `gen-keys.mjs` stammen.

**`/rest/v1/` antwortet mit 403, obwohl der anon-Key stimmt.** Kein Fehler:
Upstream beschränkt die OpenAPI-Wurzel auf `service_role`. Eine echte
Tabellen-Abfrage (`/rest/v1/<tabelle>`) funktioniert mit dem anon-Key.

**PostgREST antwortet mit 404 auf existierende Tabellen.**
`PGRST_DB_SCHEMAS` weicht von `supabase/config.toml` (`[api] schemas`) ab.

**Realtime verbindet nicht, App funktioniert sonst.** Entweder blockt die
CSP (`NEXT_PUBLIC_SUPABASE_URL` gesetzt? danach neu gebaut?) oder der
Container-Name wurde geändert: `realtime-dev.supabase-realtime` ist in
`kong.yml` an vier Stellen als Upstream verdrahtet. Umbenennen führt zu
502ern bei stillem Rest.

**Ein Crewmitglied taucht nach dem Login doppelt auf.** Die Auth-Daten
wurden nicht importiert und `persons.auth_user_id` nicht genullt — siehe
Schritt 4a.

**Seed-UUIDs.** Zod v4 `.uuid()` ist strikt. Platzhalter wie
`aaaaaaaa-0000-0000-…` werden abgelehnt („Ungültige Auswahl."). Konvention:
Versions-Nibble `4`, Variant `8`.
