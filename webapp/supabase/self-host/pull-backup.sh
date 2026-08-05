#!/usr/bin/env bash
#
# Holt das jüngste DB-Backup vom Server und legt es VERSCHLÜSSELT lokal ab.
#
#   ./pull-backup.sh [ZIELVERZEICHNIS]
#
# Gegenstück zu backup.sh: das dumpt im Container, dieses Skript holt die
# Datei weg. Ein Backup, das nur auf derselben Maschine liegt wie die
# Datenbank, überlebt keinen Serververlust.
#
# ⚠️ Warum ZIEHEN und nicht schieben: so liegen keine Zugangsdaten zu
# deinem Speicher auf dem Server, und ein kompromittierter oder verlorener
# Server kann die ausgelagerten Kopien nicht mitnehmen.
#
# ⚠️ Der Dump enthält Klarnamen und E-Mail-Adressen der Crew. Er wird
# deshalb im Flug mit `age` verschlüsselt — der Klartext berührt die lokale
# Platte nie. Ohne Schlüssel bricht das Skript ab, statt unverschlüsselt
# abzulegen.
#
# Einmalige Vorbereitung:
#
#   brew install age
#   age-keygen -o ~/.config/bordkasse-backup.key   # Datei sicher aufbewahren!
#
# ⚠️ Diesen Schlüssel getrennt von den Backups sichern (Passwortmanager,
# ausgedruckt im Ordner). Ohne ihn sind alle Kopien unlesbar — dann hättest
# du das Backup-Problem nur verschoben.
#
# Wiederherstellen:
#
#   age -d -i ~/.config/bordkasse-backup.key datei.sql.gz.age > dump.sql.gz
#
# Danach zurückspielen wie in docs/self-hosting.md, Abschnitt „Backup"
# beschrieben.

set -euo pipefail

DEST="${1:-$HOME/Documents/bordkasse-backups}"
SSH_HOST="${BORDKASSE_SSH_HOST:-web-1}"
# Absichtlich OHNE Default: dieses Repo ist öffentlich, und die UUID der
# Coolify-Anwendung gehört nicht hinein. In ~/.zshrc o. ä. setzen.
APP_UUID="${BORDKASSE_APP_UUID:-}"
KEY="${BORDKASSE_AGE_KEY:-$HOME/.config/bordkasse-backup.key}"
KEEP_DAYS="${KEEP_DAYS:-180}"

for tool in age ssh; do
  command -v "$tool" >/dev/null || { echo "FEHLER: '$tool' fehlt (brew install age)." >&2; exit 1; }
done
[ -n "$APP_UUID" ] || { echo "FEHLER: BORDKASSE_APP_UUID nicht gesetzt (UUID der Coolify-Anwendung)." >&2; exit 1; }
[ -f "$KEY" ] || { echo "FEHLER: Schlüssel $KEY fehlt — siehe Kopf dieser Datei." >&2; exit 1; }

RECIPIENT="$(age-keygen -y "$KEY")"

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d)"
OUT="${DEST}/bordkasse_${STAMP}.sql.gz.age"

# Der Container-Name wird auf dem Server dynamisch ermittelt — Coolify
# ignoriert `container_name` und vergibt eigene Namen. `head -n1`, weil der
# Filter als Teilstring matcht und während eines Redeploys kurz zwei
# Container passen.
#
# `cat` statt `docker cp`: der Inhalt fließt durch die Pipe direkt in `age`,
# es entsteht nirgends eine unverschlüsselte Zwischendatei.
REMOTE='
set -e
C=$(docker ps --filter name=db-'"$APP_UUID"' --format "{{.Names}}" | head -n1)
[ -n "$C" ] || { echo "kein db-Container gefunden" >&2; exit 1; }
F=$(docker exec "$C" sh -c "ls -t /backups/bordkasse_*.sql.gz 2>/dev/null | head -n1")
[ -n "$F" ] || { echo "keine Backup-Datei in /backups" >&2; exit 1; }
echo "$F" >&2
docker exec "$C" cat "$F"
'

# Erst in eine Temp-Datei, an ihren endgültigen Platz erst nach der Prüfung
# unten. Sonst überschriebe ein zweiter, fehlgeschlagener Lauf am selben Tag
# (gleicher Dateiname) die bereits geprüfte gute Kopie mit Schrott.
#
# `mktemp` statt eines festen `.part`-Namens: zwei gleichzeitige Läufe (etwa
# ein Handstart, während der Wochen-Job noch läuft) schrieben sonst in
# dieselbe Datei und einer der beiden bräche mit einer irreführenden
# Meldung ab. Nebeneffekt: ein von `kill -9` hinterlassenes Fragment
# blockiert nichts.
TMP="$(mktemp "${DEST}/.pull-backup.XXXXXX")"
ERR="$(mktemp "${DEST}/.pull-backup-err.XXXXXX")"
trap 'rm -f "$TMP" "$ERR"' EXIT

# shellcheck disable=SC2029  # Der Befehl soll bewusst remote expandiert werden.
if ! ssh "$SSH_HOST" "$REMOTE" 2>"$ERR" | age -r "$RECIPIENT" -o "$TMP"; then
  cat "$ERR" >&2
  echo "FEHLER: Übertragung fehlgeschlagen — vorhandene Kopien bleiben unberührt." >&2
  exit 1
fi

# Gegenprobe: lässt sich das Archiv wieder entschlüsseln UND ist das
# gzip darin intakt? Ohne diesen Schritt hätte man eine Datei, deren
# Brauchbarkeit sich erst im Ernstfall zeigt — also zu spät. Das prüft
# Transport und Verschlüsselung, NICHT ob der Dump inhaltlich vollständig
# ist — dafür sorgen die Inhaltsprüfungen in backup.sh auf dem Server.
age -d -i "$KEY" "$TMP" | gzip -t
SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt 10000 ]; then
  echo "FEHLER: nur ${SIZE} Bytes — sieht abgebrochen aus." >&2
  exit 1
fi

mv "$TMP" "$OUT"
chmod 600 "$OUT"
trap 'rm -f "$ERR"' EXIT

echo "OK: $OUT ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B"))"

# Wie alt ist der Dump, den wir geholt haben? Der Dateiname auf dem Server
# trägt den Zeitstempel seiner Entstehung. Fällt der nächtliche Task aus
# (Container neu, Cron tot), zöge dieses Skript sonst tagelang denselben
# alten Dump und meldete jedes Mal zufrieden „OK".
REMOTE_NAME="$(basename "$(tail -n1 "$ERR")" 2>/dev/null || true)"
case "$REMOTE_NAME" in
  bordkasse_*)
    DUMP_DAY="${REMOTE_NAME#bordkasse_}"
    DUMP_DAY="${DUMP_DAY%%_*}"
    if [ "$DUMP_DAY" != "$STAMP" ]; then
      echo "WARNUNG: Der Dump auf dem Server ist vom ${DUMP_DAY}, nicht von heute." >&2
      echo "         Läuft der Scheduled Task 'bordkasse-backup' noch?" >&2
    fi
    ;;
esac

# Alte lokale Kopien aufräumen — erst nach erfolgreicher Prüfung, damit ein
# fehlgeschlagener Lauf nie die letzten guten Kopien mitnimmt.
find "$DEST" -name 'bordkasse_*.sql.gz.age' -type f -mtime "+${KEEP_DAYS}" -delete
