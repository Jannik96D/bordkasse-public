#!/usr/bin/env bash
#
# Nächtliches Backup der Bordkasse-Datenbank.
#
#   ./backup.sh [ZIELVERZEICHNIS]
#
# Als Coolify Scheduled Task einrichten (z. B. täglich 2:00). Sichert die
# KOMPLETTE Postgres-Instanz — public-Schema (Törns, Buchungen, Bilanz) UND
# auth (die Logins der Crew). Ein Dump ohne `auth` wäre die teuerste Sorte
# Fehler: die Zahlen wären zurück, aber niemand käme mehr rein.
#
# ⚠️ Ein Backup, das nur auf demselben Server liegt, ist kein Backup.
# Platten- oder Serververlust nimmt beides mit. Siehe „Auslagern" unten.
#
# ⚠️ Der Dump enthält Klarnamen und E-Mail-Adressen der Crew — also
# personenbezogene Daten. Zielverzeichnis entsprechend eng berechtigen und
# beim Auslagern verschlüsseln.

set -euo pipefail

DEST="${1:-/var/backups/bordkasse}"
CONTAINER="bordkasse-db"
KEEP_DAYS="${KEEP_DAYS:-30}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="${DEST}/bordkasse_${STAMP}.sql.gz"

mkdir -p "$DEST"

# --clean --if-exists: der Dump kann in eine bestehende DB zurückgespielt
# werden, ohne vorher manuell aufzuräumen.
# --quote-all-identifiers: schützt vor Reserved-Word-Überraschungen bei
# einem späteren Postgres-Upgrade.
docker exec "$CONTAINER" pg_dump \
  --username=postgres \
  --dbname=postgres \
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

# Alte Dumps aufräumen. Erst NACH der erfolgreichen Prüfung oben, damit ein
# fehlgeschlagener Lauf nie die letzten guten Backups mitnimmt.
find "$DEST" -name 'bordkasse_*.sql.gz' -type f -mtime "+${KEEP_DAYS}" -delete

# ── Auslagern ────────────────────────────────────────────────────────────
# Hier den Transfer auf ein anderes System ergänzen (rclone/rsync/scp auf
# NAS oder Objektspeicher). Ohne diesen Schritt liegt die einzige Kopie auf
# derselben Maschine wie das Original.
#
# Beispiel:
#   rclone copy "$OUT" remote:bordkasse-backups/
