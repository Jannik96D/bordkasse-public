#!/usr/bin/env bash
#
# seed-demo.sh — Lokales Demo-Setup für die /about Screenshots
#
# Was es macht:
#   1. Verifiziert dass Supabase lokal läuft (sonst klare Fehlermeldung).
#   2. Setzt die DB komplett zurück + spielt alle Migrationen ein.
#      Das in supabase/seed.sql referenzierte alte Schema (persons.email)
#      bricht — wir fangen den Fehler ab und machen mit seed_demo.sql weiter.
#   3. Legt zwei Auth-User via Supabase Admin-API an
#      (skipper@example.com = Anna, clara@example.com = Clara).
#      Direkte INSERTs in auth.users funktionieren in der aktuellen
#      Supabase-Version nicht zuverlässig ("Database error finding user"
#      beim Login) — die Admin-API legt die User korrekt inkl. identities an.
#   4. Verknüpft persons.auth_user_id mit den frisch erzeugten Auth-IDs.
#   5. Optional: startet im Anschluss das take-screenshots.ts-Skript,
#      wenn `--screenshots` mitgegeben wird (Voraussetzung: Dev-Server auf
#      :3000 läuft).
#
# Aufruf:
#   cd webapp
#   ./scripts/seed-demo.sh
#   ./scripts/seed-demo.sh --screenshots   # plus Screenshots schießen
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SUPABASE_URL="http://127.0.0.1:54321"
DB_HOST="127.0.0.1"
DB_PORT="54322"
DB_USER="postgres"
DB_PASS="postgres"
DB_NAME="postgres"
DB_CONTAINER="supabase_db_bordkasse"

# ── Hilfsfunktionen ──────────────────────────────────────────────────

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

psql_exec() {
  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"
}

# ── 1. Voraussetzungen prüfen ────────────────────────────────────────

bold "→ Prüfe Supabase-Status"
if ! supabase status >/dev/null 2>&1; then
  red "Supabase läuft nicht. Starte mit:"
  red "  supabase start"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
  red "DB-Container ${DB_CONTAINER} nicht gefunden — supabase start neu ausführen."
  exit 1
fi

# Service-Role-Key aus .env.local lesen
if [ ! -f .env.local ]; then
  red ".env.local nicht gefunden in $ROOT_DIR"
  exit 1
fi
SVC_KEY="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)"
if [ -z "$SVC_KEY" ]; then
  red "SUPABASE_SERVICE_ROLE_KEY fehlt in .env.local"
  exit 1
fi

green "✓ Supabase läuft, DB-Container da, Service-Role-Key gefunden"

# ── 2. DB reset (mit seed.sql-Workaround) ────────────────────────────

bold "→ DB zurücksetzen + Migrationen einspielen"
# `supabase db reset` läuft supabase/seed.sql automatisch — das schlägt aktuell
# fehl, weil seed.sql noch persons.email referenziert (Spalte ist seit 0013
# weg). Der Reset selbst (Migrationen) läuft trotzdem komplett durch, deshalb
# fangen wir den Exit-Code ab und prüfen den Tabellen-State.
if ! supabase db reset 2>&1 | tail -20; then
  yellow "supabase db reset hat einen non-zero exit code zurückgegeben."
  yellow "Das ist erwartbar wegen des kaputten seed.sql (persons.email)."
fi

# Sanity-Check: ist die Migration 0028 (prepayment_reminder_log) drin?
if ! psql_exec -tAc "SELECT 1 FROM information_schema.tables WHERE table_name='prepayment_reminder_log';" | grep -q 1; then
  red "Migration 0028 fehlt — DB-Reset scheint fehlgeschlagen."
  exit 1
fi

# Falls trips/persons noch Daten aus seed.sql haben (sollte nicht — seed
# crashed vor INSERT), räumen wir defensiv auf.
psql_exec -c "DELETE FROM trips; DELETE FROM persons;" >/dev/null

green "✓ Migrationen sind drin, DB ist leer"

# ── 3. Auth-User via Admin-API anlegen ───────────────────────────────

bold "→ Auth-User für Anna + Clara anlegen"

for EMAIL in skipper@example.com clara@example.com; do
  # Falls schon vorhanden (Re-Run): überspringen
  EXISTING=$(psql_exec -tAc "SELECT id FROM auth.users WHERE email='${EMAIL}';" | tr -d ' ')
  if [ -n "$EXISTING" ]; then
    yellow "  ${EMAIL} existiert schon (${EXISTING:0:8}…), überspringe"
    continue
  fi

  echo "  → ${EMAIL}"
  RESP=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
    -H "apikey: ${SVC_KEY}" \
    -H "Authorization: Bearer ${SVC_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${EMAIL}\",\"email_confirm\":true}")
  if ! echo "$RESP" | grep -q '"id"'; then
    red "Admin-API-Call fehlgeschlagen für ${EMAIL}:"
    echo "$RESP"
    exit 1
  fi
done

green "✓ Auth-User da"

# ── 4. seed_demo.sql einspielen ──────────────────────────────────────

bold "→ Demo-Daten einspielen (seed_demo.sql)"
psql_exec < supabase/seed_demo.sql >/dev/null

# persons.auth_user_id mit den echten Auth-UUIDs verknüpfen.
# (Das seed_demo.sql nutzt feste UUIDs — die stimmen nicht mit den von der
# Admin-API erzeugten Auth-IDs überein. Wir holen die Auth-IDs nach Email
# und mappen auf den display_name.)
psql_exec <<SQL >/dev/null
UPDATE persons SET auth_user_id = (
  SELECT id FROM auth.users WHERE email='skipper@example.com'
) WHERE display_name = 'Anna';

UPDATE persons SET auth_user_id = (
  SELECT id FROM auth.users WHERE email='clara@example.com'
) WHERE display_name = 'Clara';
SQL

green "✓ Demo-Daten + persons.auth_user_id-Verknüpfung"

# ── 5. Verifikation ──────────────────────────────────────────────────

bold "→ Sanity-Checks"
TRIPS=$(psql_exec -tAc "SELECT count(*) FROM trips;")
PLANS=$(psql_exec -tAc "SELECT count(*) FROM prepayment_plan;")
LINKED=$(psql_exec -tAc "SELECT count(*) FROM persons WHERE auth_user_id IS NOT NULL;")
echo "  Trips: ${TRIPS} (erwartet 3)"
echo "  Anzahlungs-Pläne: ${PLANS} (erwartet 1)"
echo "  Verknüpfte Personen: ${LINKED} (erwartet 2)"
if [ "$TRIPS" != "3" ] || [ "$PLANS" != "1" ] || [ "$LINKED" != "2" ]; then
  red "Sanity-Check fehlgeschlagen — bitte Logs prüfen."
  exit 1
fi
green "✓ Alles plausibel"

# ── 6. Optional: Screenshots ─────────────────────────────────────────

if [ "${1:-}" = "--screenshots" ]; then
  bold "→ Screenshots schießen"
  if ! curl -sf "http://localhost:3000/login" >/dev/null 2>&1; then
    red "Dev-Server auf :3000 antwortet nicht. Bitte in einem zweiten Terminal:"
    red "  pnpm dev"
    exit 1
  fi
  npx tsx scripts/take-screenshots.ts
fi

bold "✓ Demo-Setup fertig."
echo
echo "Login lokal:"
echo "  Skipper:    skipper@example.com (= Anna, Admin)"
echo "  Crew:       clara@example.com   (= Clara, regulärer User)"
echo
echo "Magic-Link-Mails landen in Mailpit unter http://127.0.0.1:54324"
