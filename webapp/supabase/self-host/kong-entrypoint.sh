#!/bin/sh
# Custom entrypoint for Kong that builds Lua expressions for request-transformer
# and performs environment variable substitution in the declarative config.

# ── CORS_ORIGIN aus SITE_URL ableiten ────────────────────────────────────
#
# Die `cors`-Plugins in kong.yml schränken `origins` auf genau einen Wert ein.
# Der muss BYTEWEISE dem `Origin`-Header des Browsers entsprechen, also
# `schema://host[:port]` — kleingeschrieben, ohne Pfad und ohne Trailing-Slash.
# Passt er nicht, bricht nichts laut: server-seitige Calls laufen weiter,
# während jeder Browser-Call (Token-Refresh, Realtime) still an der
# CORS-Preflight scheitert.
#
# ⚠️ SITE_URL wird GETEILT: dieselbe Variable geht als GOTRUE_SITE_URL an den
# auth-Container, wo ein Trailing-Slash völlig harmlos ist (das Mail-Template
# hängt `/auth/confirm` an). Ein bestehendes, funktionierendes Deployment darf
# deshalb NICHT daran scheitern, dass Kong strengere Ansprüche stellt als
# GoTrue — sonst nimmt ein Neustart (Reboot, Redeploy, `restart: unless-stopped`)
# das ganze Gateway mit herunter. Wir normalisieren also, statt abzubrechen,
# und schreiben das Ergebnis in eine Kong-eigene Variable.
if [ -z "$SITE_URL" ]; then
    echo "FEHLER: SITE_URL ist nicht gesetzt — die CORS-Allowlist in kong.yml bliebe leer und jeder Browser-Zugriff auf die API würde scheitern. Kong startet nicht." >&2
    exit 1
fi

# Schema + Host kleinschreiben (Kong liefert den Wert unverändert im
# `Access-Control-Allow-Origin` aus; der Browser vergleicht gegen seinen
# kleingeschriebenen Origin), dann alles ab dem ersten `/` nach dem Schema
# abschneiden — das erschlägt Trailing-Slash, Pfad und Query in einem.
CORS_ORIGIN="$(printf '%s' "$SITE_URL" | tr '[:upper:]' '[:lower:]' | sed -E 's#^([a-z][a-z0-9+.-]*://[^/?#]*).*#\1#')"

case "$CORS_ORIGIN" in
    http://?*|https://?*) ;;
    *) echo "FEHLER: Aus SITE_URL ('$SITE_URL') lässt sich kein Origin ableiten — erwartet wird http(s)://host[:port]. Kong startet nicht, weil die CORS-Allowlist sonst nie matcht." >&2; exit 1 ;;
esac

# Kong nutzt einen `origins`-Eintrag nur dann als LITERAL, wenn er
# `^[A-Za-z0-9.:/-]+$` erfüllt (siehe plugins/cors/handler.lua); alles andere
# behandelt es als Regex — dann matcht z. B. eine IPv6-Adresse oder ein
# Umlaut-Domain-Name still gar nicht mehr. Lieber hier abbrechen.
case "$CORS_ORIGIN" in
    *[!A-Za-z0-9.:/-]*) echo "FEHLER: SITE_URL ('$SITE_URL') enthält Zeichen, die Kong als Regex statt als festen Origin behandeln würde (erlaubt: A-Z a-z 0-9 . : / -). Kong startet nicht." >&2; exit 1 ;;
esac

if [ "$CORS_ORIGIN" != "$SITE_URL" ]; then
    echo "HINWEIS: SITE_URL ('$SITE_URL') wurde für die CORS-Allowlist zu '$CORS_ORIGIN' normalisiert (Kleinschreibung, ohne Pfad/Trailing-Slash). GOTRUE_SITE_URL bleibt unverändert." >&2
fi
export CORS_ORIGIN

# Die Dashboard-Route (kong.yml, Consumer DASHBOARD) ist der einzige Schutz vor
# vollem, RLS-losem DB-Zugriff über Studio, sobald das `studio`-Profil läuft.
# Ohne Passwort wäre das Basic-Auth-Credential leer und damit wirkungslos.
#
# Bewusst KEIN `exit 1`: die Route ist optional (das `studio`-Profil startet
# standardmäßig nicht), Kong dagegen bedient Auth, REST und Realtime der
# ganzen App. Ein harter Abbruch nähme für einen abgeschalteten Dashboard-
# Zugang die komplette App mit herunter — und .env.example liefert diese
# beiden Werte bewusst leer aus. Stattdessen verriegeln wir die Route mit
# einem Zufallspasswort: Studio ist dann unerreichbar (401), aber niemals
# offen, und der Rest des Gateways läuft.
if [ -z "$DASHBOARD_USERNAME" ] || [ -z "$DASHBOARD_PASSWORD" ]; then
    DASHBOARD_USERNAME="disabled"
    DASHBOARD_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '=+/ \n')"
    # Das Ergebnis MUSS geprüft werden: schlägt die Kette fehl (kein base64 im
    # Image, kein /dev/urandom), wäre das Passwort leer — und ein leeres
    # Basic-Auth-Credential öffnet Studio für jeden. Lieber gar nicht starten,
    # als die Datenbank an RLS vorbei offenzulegen. `${#VAR}` ist POSIX.
    if [ "${#DASHBOARD_PASSWORD}" -lt 20 ]; then
        echo "FEHLER: Zufallspasswort für die Studio-Route konnte nicht erzeugt werden (head/base64/urandom nicht verfügbar?) — Kong startet nicht, statt Studio ohne wirksames Passwort auszuliefern." >&2
        exit 1
    fi
    export DASHBOARD_USERNAME DASHBOARD_PASSWORD
    echo "WARNUNG: DASHBOARD_USERNAME/DASHBOARD_PASSWORD ist leer — die Studio-Route wird mit einem Zufallspasswort verriegelt (kein Login möglich). Zum Nutzen von Studio beide Werte in der Env setzen." >&2
else
    # Selbst gesetzte Werte: ein Hochkomma zerlegt den einfach gequoteten
    # YAML-Skalar in kong.yml und lässt Kong mit einem kryptischen Parse-Fehler
    # sterben — hier lieber mit klarer Ansage abbrechen.
    case "$DASHBOARD_USERNAME$DASHBOARD_PASSWORD" in
        *\'*) echo "FEHLER: DASHBOARD_USERNAME/DASHBOARD_PASSWORD darf kein Hochkomma (') enthalten — das bricht die YAML-Struktur von kong.yml." >&2; exit 1 ;;
    esac
    # Kein harter Abbruch bei kurzen Passwörtern: das ist die bewusste
    # Entscheidung des Betreibers, und ein Lockout des Gateways wäre die
    # schlechtere Antwort. Nur ein deutlicher Hinweis.
    if [ "${#DASHBOARD_PASSWORD}" -lt 16 ]; then
        echo "WARNUNG: DASHBOARD_PASSWORD ist kürzer als 16 Zeichen — die Studio-Route ist der einzige Schutz vor vollem DB-Zugriff an RLS vorbei." >&2
    fi
fi

# Build Lua expressions for translating opaque API keys to asymmetric JWTs.
# When opaque keys are not configured (empty env vars), expressions fall through
# to legacy-only behavior - just passing apikey as-is.
#
# Full expression logic (when opaque keys are configured):
#   1. If Authorization header exists and is NOT an sb_ key -> pass through (user session JWT)
#   2. If apikey matches secret key -> set service_role asymmetric JWT internal "API key"
#   3. If apikey matches publishable key -> set anon asymmetric JWT internal "API key"
#   4. Fallback: pass apikey as-is (legacy HS256 JWT)

if [ -n "$SUPABASE_SECRET_KEY" ] && [ -n "$SUPABASE_PUBLISHABLE_KEY" ]; then
    # Opaque keys configured -> full translation expressions
    export LUA_AUTH_EXPR="\$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) or (headers.apikey == '$SUPABASE_SECRET_KEY' and 'Bearer $SERVICE_ROLE_KEY_ASYMMETRIC') or (headers.apikey == '$SUPABASE_PUBLISHABLE_KEY' and 'Bearer $ANON_KEY_ASYMMETRIC') or headers.apikey)"

    # Realtime WebSocket: reads from query_params.apikey (supabase-js sends apikey
    # via query string), outputs to x-api-key header which Realtime checks first.
    export LUA_RT_WS_EXPR="\$((query_params.apikey == '$SUPABASE_SECRET_KEY' and '$SERVICE_ROLE_KEY_ASYMMETRIC') or (query_params.apikey == '$SUPABASE_PUBLISHABLE_KEY' and '$ANON_KEY_ASYMMETRIC') or query_params.apikey)"
else
    # Legacy API keys, not sb_ API keys -> pass apikey through unchanged
    export LUA_AUTH_EXPR="\$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) or headers.apikey)"
    export LUA_RT_WS_EXPR="\$(query_params.apikey)"
fi

# Substitute environment variables in the Kong declarative config.
# Uses awk instead of eval/echo to preserve YAML quoting (eval strips double
# quotes, breaking "Header: value" patterns that YAML parses as mappings).
awk '{
  result = ""
  rest = $0
  while (match(rest, /\$[A-Za-z_][A-Za-z_0-9]*/)) {
    varname = substr(rest, RSTART + 1, RLENGTH - 1)
    if (varname in ENVIRON) {
      result = result substr(rest, 1, RSTART - 1) ENVIRON[varname]
    } else {
      result = result substr(rest, 1, RSTART + RLENGTH - 1)
    }
    rest = substr(rest, RSTART + RLENGTH)
  }
  print result rest
}' /home/kong/temp.yml > "$KONG_DECLARATIVE_CONFIG"

# Remove empty key-auth credentials (unconfigured opaque keys)
sed -i '/^[[:space:]]*- key:[[:space:]]*$/d' "$KONG_DECLARATIVE_CONFIG"

exec /entrypoint.sh kong docker-start
