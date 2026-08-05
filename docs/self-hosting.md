# Self-Hosting: Bordkasse auf eigenem Server (Coolify)

Runbook für den Umzug von Supabase Cloud + Vercel auf einen selbst
gehosteten Stack.

**Warum überhaupt:** Der Supabase-Free-Tier pausiert ein Projekt nach ~7
Tagen Inaktivität. Da nicht jede Woche ein Törn stattfindet, schlief die
Bordkasse regelmäßig ein. Selbst gehostet gibt es diese Regel nicht — es
sind Docker-Container, die laufen, bis jemand sie stoppt.

---

## 1. Architektur

Sieben Container statt der 14 des vollen Supabase-Stacks. Weggelassen ist
nur, was die App nachweislich nicht nutzt:

| Container | Rolle |
|---|---|
| `db` | Postgres 17 — der eigentliche Datenbestand |
| `auth` | GoTrue, verschickt die Magic-Link-Mails |
| `rest` | PostgREST, bedient alle Lese-Queries der App |
| `realtime` | Live-Updates für `components/realtime-trip.tsx` |
| `meta` | Backend für Studio |
| `studio` | Web-UI auf die Datenbank |
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
Setze ein langes, einmaliges `DASHBOARD_PASSWORD`.

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

Solange die App noch auf Vercel läuft, dort in den Env-Vars ändern:

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
- [ ] **Studio** erreichbar und fragt nach Basic-Auth.
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
`next.config.ts`. Beides ist auf Vercel folgenlos, kann also fertig
bereitliegen, bevor umgeschaltet wird.

### Neue Coolify-Anwendung

| Feld | Wert |
|---|---|
| Build Pack | `Dockerfile` |
| Base Directory | `/webapp` |
| Dockerfile Location | `/webapp/Dockerfile` |
| Port | `3000` |

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

### Die beiden Crons

`vercel.json` fällt weg — **aber erst beim Umschalten, nicht vorher**. Es
trägt neben den Crons auch `regions: ["fra1"]`; ohne die Datei liefe die
App auf Vercel wieder in `iad1` (USA), und die beiden Crons hörten auf zu
laufen (DSGVO-Löschung und Anzahlungs-Erinnerungen). Ersatz als Coolify
Scheduled Tasks (Container = App-Container):

| Name | Frequenz | Command |
|---|---|---|
| `purge` | `0 3 * * *` | `curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/purge` |
| `prepayment-reminders` | `0 7 * * *` | `curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/prepayment-reminders` |

`-f` ist wichtig: ohne das Flag liefert `curl` bei einem 401 oder 500
Exit-Code 0, und der Task meldet grün, obwohl nichts passiert ist.

### Beim Umschalten

1. Domain `bordkasse.dieter.ms` umhängen — **macht der Server-Betreiber.**
2. `MAILER_TEMPLATE_MAGIC_LINK` im Supabase-Stack auf den internen
   Docker-Namen der App zeigen lassen
   (`http://<app-container>:3000/email/magic-link.html`). Danach eine echte
   Testmail ansehen: GoTrue fällt bei nicht erreichbarer URL **still** auf
   sein unbrandetes Default zurück.
3. `webapp/vercel.json` entfernen und das Vercel-Projekt abschalten.
4. **Datenschutzerklärung** (`app/datenschutz/page.tsx`): Vercel Inc. und
   Supabase Inc. fallen als Auftragsverarbeiter weg, der Betreiber des
   Servers kommt hinzu (mit ladungsfähiger Identität), Hetzner als
   Unterauftragsverarbeiter. Rechtlich der empfindlichste Schritt — und
   getrennt davon zu klären, dass der Betreiber damit Auftragsverarbeiter
   für die Daten der Crew wird.

---

## 10. Betrieb

**Updates:** Image-Versionen in `docker-compose.yml` sind gepinnt. Zum
Aktualisieren dort die Version hochziehen, committen und
`docker compose up -d`. Vorher Backup. Bewusst kein `:latest` — sonst
ändert sich die Infrastruktur beim nächsten Neustart unbemerkt.

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

**Postgres-Konsole:**

```bash
docker exec -it bordkasse-db psql -U postgres -d postgres
```

**RAM prüfen:** `docker stats --no-stream`

---

## 11. Rollback

Solange Supabase Cloud noch existiert, ist der Rückweg kurz: die drei
Env-Vars der App auf die alten Werte zurücksetzen und neu deployen. Das
Cloud-Projekt erst löschen, wenn der neue Stack einen echten Törn
überlebt hat.

Wurde in der Cloud bereits gelöscht: Sicherung aus Schritt 0 einspielen.

---

## 12. Bekannte Fallen

**Magic-Link-Mail kommt unbrandet an.** Selbst gehostetes GoTrue liest
Templates **nur per HTTP-URL**, nicht aus gemounteten Dateien. Ist
`MAILER_TEMPLATE_MAGIC_LINK` nicht erreichbar, fällt GoTrue **still** auf
sein Default zurück — kein Fehler im Log. Prüfen:

```bash
docker exec bordkasse-auth wget -qO- "$MAILER_TEMPLATE_MAGIC_LINK" | head -5
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
