#!/usr/bin/env bash
#
# Nächtliches Backup der Bordkasse-Datenbank.
#
# ⚠️ Dieses Skript läuft INNERHALB des `db`-Containers, nicht auf dem Host.
#
# Grund: Coolifys „Scheduled Tasks" führen ihren Befehl in einem Container
# des Stacks aus, nicht auf der Maschine. Eine Host-Variante mit
# `docker exec` wäre dort gar nicht einrichtbar (kein Docker-Socket im
# Container) — und ein System-Cron auf dem Host läge außerhalb des Repos und
# außerhalb dessen, was wir auf einer fremden Maschine anlegen wollen.
# Deshalb: pg_dump läuft im Container, der Docker-Socket bleibt unangetastet.
#
# Als Coolify Scheduled Task (Container `db`, täglich 0:00 — `0 0 * * *`):
#
# ⚠️ Die Uhrzeit ist abgestimmt: der Server-Betreiber holt die Dumps um
# 02:00 vom Server weg. Um 0:00 zu dumpen heißt, dass jede Nacht der
# frische Stand mitgeht. Wer die Zeit verschiebt, muss das mit ihm klären —
# sonst wandert nachts der Dump des Vortags nach außen.
#
#   bash /usr/local/bin/bordkasse-backup
#
# Manuell vom Host aus — Container-Name dynamisch ermitteln, Coolify
# ignoriert `container_name` und vergibt eigene Namen:
#
#   docker exec "$(docker ps --filter name=db-<app-uuid> --format '{{.Names}}' \
#     | head -n1)" bash /usr/local/bin/bordkasse-backup
#
# (`head -n1`, weil `--filter name=` als Teilstring matcht: während eines
# Redeploys existiert der alte Container kurz noch.)
#
# Sichert die KOMPLETTE Postgres-Instanz — public-Schema (Törns, Buchungen,
# Bilanz) UND auth (die Logins der Crew). Ein Dump ohne `auth` wäre die
# teuerste Sorte Fehler: die Zahlen wären zurück, aber niemand käme mehr
# rein.
#
# ⚠️ Ein Backup, das nur auf demselben Server liegt, ist kein Backup.
# Platten- oder Serververlust nimmt beides mit. Das Auslagern passiert
# bewusst NICHT hier: der Container hat kein rclone/ssh und soll auch keine
# Zugangsdaten zu einem Fernziel sehen. Siehe docs/self-hosting.md,
# Abschnitt „Backup".
#
# ⚠️ Der Dump enthält Klarnamen und E-Mail-Adressen der Crew — also
# personenbezogene Daten. Beim Auslagern verschlüsseln.

set -euo pipefail

# Standardziel ist das Named Volume `db-backups`, das docker-compose.yml
# unter /backups mountet. Named Volume statt Bind-Mount aus demselben Grund
# wie bei PGDATA: ein Coolify-Redeploy mit frischem Clone oder
# `git clean -xfd` nähme ein Verzeichnis im Checkout mit — hier also genau
# die Sicherungen, die man dann bräuchte.
DEST="${1:-/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

# Der Superuser dieses Images. NICHT `postgres`: die auth-Tabellen gehören
# supabase_auth_admin, und ein Dump als schwächere Rolle lässt still genau
# die Zeilen aus, die man beim Restore am dringendsten braucht.
DB_USER="${BACKUP_DB_USER:-supabase_admin}"
DB_NAME="${POSTGRES_DB:-postgres}"

# Verbindung über den Unix-Socket — kein Netzwerk, kein Passwort.
# PGHOST wird hier EXPLIZIT gesetzt: der Container kennt nur
# `POSTGRES_HOST`, und das liest libpq nicht. Ohne diese Zeile klappt es
# bloß, solange der einkompilierte Default-Socket-Pfad des Images zufällig
# derselbe ist — eine Abhängigkeit vom Image-Build, die niemand garantiert.
export PGHOST="${PGHOST:-${POSTGRES_HOST:-/var/run/postgresql}}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="${DEST}/bordkasse_${STAMP}.sql.gz"

mkdir -p "$DEST"

# --clean --if-exists: der Dump kann in eine bestehende DB zurückgespielt
# werden, ohne vorher manuell aufzuräumen.
# --quote-all-identifiers: schützt vor Reserved-Word-Überraschungen bei
# einem späteren Postgres-Upgrade.
#
# Bricht pg_dump ab, endet das Skript hier (pipefail) — die angefangene
# Datei bleibt zur Analyse liegen, aber die Aufräum-Zeile unten läuft nicht
# mehr. Ein kaputter Lauf nimmt also nie die letzten guten Backups mit.
pg_dump \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --clean --if-exists \
  --quote-all-identifiers \
  | gzip -9 > "$OUT"

# Ein leerer oder abgebrochener Dump ist schlimmer als keiner, weil er
# Sicherheit vortäuscht. gzip -t prüft die Integrität, die Größenprüfung
# fängt den Fall „Dump lief auf einen Fehler und ist fast leer".
gzip -t "$OUT"
SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 10000 ]; then
  echo "FEHLER: Dump ist nur ${SIZE} Bytes groß — sieht abgebrochen aus." >&2
  echo "Datei bleibt zur Analyse liegen: $OUT" >&2
  exit 1
fi

# Gegenprobe auf Inhalt: sind die beiden Schemata wirklich drin?
#
# `grep -c … || true` statt `grep -q`: `grep -q` beendet sich beim ERSTEN
# Treffer, gzip bekommt daraufhin SIGPIPE und endet ≠ 0 — mit `set -o
# pipefail` schlüge die Prüfung dann fehl, OBWOHL der Suchbegriff im Dump
# steht. Das passiert erst ab genug Daten (bei kleinen Dumps passt alles in
# den Pipe-Puffer), also genau dann, wenn niemand mehr damit rechnet: der
# nächtliche Task lief monatelang grün und kippt plötzlich dauerhaft auf
# „unvollständige Sicherung". `grep -c` liest bis zum Ende, kein SIGPIPE.
for needle in 'CREATE TABLE "public"."transactions"' '"auth"."users"'; do
  count=$(gzip -dc "$OUT" | grep -c -- "$needle" || true)
  if [ "${count:-0}" -eq 0 ]; then
    echo "FEHLER: '$needle' fehlt im Dump — unvollständige Sicherung." >&2
    exit 1
  fi
done

echo "OK: $OUT ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B"))"

# Alte Dumps aufräumen. Erst NACH der erfolgreichen Prüfung oben.
find "$DEST" -name 'bordkasse_*.sql.gz' -type f -mtime "+${KEEP_DAYS}" -delete
