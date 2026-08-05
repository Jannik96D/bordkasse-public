#!/bin/sh
# Custom entrypoint for Kong that builds Lua expressions for request-transformer
# and performs environment variable substitution in the declarative config.

# ⚠️ SITE_URL trägt die CORS-Allowlist jeder Route in kong.yml
# (`origins: [$SITE_URL]`).
#
# Der Wert MUSS exakt dem Origin-Header des Browsers entsprechen, also
# `schema://host[:port]` — ohne Trailing-Slash, ohne Pfad, ohne Komma-Liste.
# Ein abweichender Wert bricht nicht laut, sondern erzeugt eine CORS-Liste, die
# NIE matcht: server-seitige Calls laufen weiter, jeder Browser-Call
# (Token-Refresh, Realtime) scheitert an der Preflight. Diagnostisch ist das die
# schlimmste Variante — deshalb hier fail-loud statt später im Betrieb rätseln.
#
# Hinweis: eine gesetzte-aber-LEERE Variable ergibt in kong.yml einen
# YAML-`null`-Eintrag, an dem Kongs Schema-Validierung ohnehin scheitert (also
# laut, nur mit unverständlicher Meldung); eine GAR NICHT gesetzte lässt die
# awk-Substitution das Literal `$SITE_URL` stehen, was still danebengeht.
if [ -z "$SITE_URL" ]; then
    echo "FEHLER: SITE_URL ist nicht gesetzt — die CORS-Allowlist in kong.yml bliebe leer und jeder Browser-Zugriff auf die API würde scheitern. Kong startet nicht." >&2
    exit 1
fi

case "$SITE_URL" in
    http://*|https://*) ;;
    *) echo "FEHLER: SITE_URL braucht ein Schema (http:// oder https://), ist aber '$SITE_URL' — der CORS-Vergleich gegen den Origin-Header würde nie matchen." >&2; exit 1 ;;
esac

# Rest nach dem Schema darf nur host[:port] sein. Deckt Trailing-Slash (GoTrue
# akzeptiert den für dieselbe Variable), Pfade und Komma-Listen ab.
case "${SITE_URL#*://}" in
    */*|*,*|*\ *) echo "FEHLER: SITE_URL muss host[:port] ohne Pfad, Trailing-Slash, Komma oder Leerzeichen sein, ist aber '$SITE_URL'." >&2; exit 1 ;;
esac

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
