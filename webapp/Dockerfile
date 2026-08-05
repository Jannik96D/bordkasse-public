# ── Bordkasse-App als Container (für Coolify) ────────────────────────────
#
# Baut die Next.js-App im `standalone`-Modus: `next build` legt unter
# .next/standalone einen eigenständigen Server samt der TATSÄCHLICH
# benötigten node_modules ab. Das Ergebnis ist ein Bruchteil eines Images
# mit vollem node_modules-Baum.
#
# ⚠️ ALLE `NEXT_PUBLIC_*`-VARIABLEN MÜSSEN BEIM BAUEN GESETZT SEIN, nicht
# erst zur Laufzeit — in Coolify also als **Build Variable** markieren:
#
#   NEXT_PUBLIC_SUPABASE_URL        (Pflicht)
#   NEXT_PUBLIC_SUPABASE_ANON_KEY   (Pflicht)
#   NEXT_PUBLIC_APP_ORIGIN          (Pflicht — Magic-Links)
#   NEXT_PUBLIC_SITE_URL            (optional, Vorrang vor APP_ORIGIN)
#   NEXT_PUBLIC_VAPID_PUBLIC_KEY    (optional — ohne ihn kein Web-Push)
#
# Grund: Next ersetzt JEDE `process.env.NEXT_PUBLIC_*`-Referenz statisch
# beim Build — auch in Server-Code. Ein Wert, der nur im Container-Env
# steht, kommt danach nirgends mehr an; das Environment zu ändern wirkt
# ohne Neubau nicht.
#
# Was dabei still bricht, wenn man es übersieht:
# - SUPABASE_URL: next.config.ts leitet den `connect-src`-Teil der CSP
#   daraus ab (landet im Routes-Manifest). Fehlt sie, lädt die App, aber der
#   Browser blockt jeden Datenzugriff und Realtime an der CSP — sieht wie
#   ein Netzwerk- oder Auth-Fehler aus.
# - APP_ORIGIN / SITE_URL: `lib/auth/origin.ts` baut daraus die
#   Magic-Link-URL. Fehlen beide, stürzen Crew-Einladungen ab — genau der
#   Vorfall, der in Produktion schon einmal passiert ist (siehe CLAUDE.md).
# - VAPID_PUBLIC_KEY: der Push-Aktivierungs-Knopf scheitert clientseitig
#   ohne aussagekräftige Meldung.
#
# Alles Übrige (Service-Role-Key, SMTP, VAPID_PRIVATE_KEY, CRON_SECRET,
# ADMIN_EMAILS, …) sind reine Laufzeit-Werte und gehören NICHT in
# Build-Args — sie landen sonst in den Image-Layern.

# ── Abhängigkeiten ───────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: der Build scheitert, wenn package.json und Lockfile
# auseinanderlaufen, statt stillschweigend andere Versionen zu ziehen.
RUN pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_ORIGIN
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_ORIGIN=$NEXT_PUBLIC_APP_ORIGIN \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Fail-loud statt eines Images, das später im Browser an der CSP hängt.
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" || \
      (echo "FEHLER: NEXT_PUBLIC_SUPABASE_URL fehlt beim Build (siehe Kopf des Dockerfiles)." >&2; exit 1)
RUN test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" || \
      (echo "FEHLER: NEXT_PUBLIC_SUPABASE_ANON_KEY fehlt beim Build." >&2; exit 1)
# Ohne Origin zeigen Magic-Links auf localhost bzw. der Versand stürzt ab.
RUN test -n "$NEXT_PUBLIC_APP_ORIGIN" -o -n "$NEXT_PUBLIC_SITE_URL" || \
      (echo "FEHLER: NEXT_PUBLIC_APP_ORIGIN (oder NEXT_PUBLIC_SITE_URL) fehlt beim Build — Magic-Links wären kaputt." >&2; exit 1)

RUN pnpm build

# ── Laufzeit ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Nicht als root laufen.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Reihenfolge wichtig: standalone bringt server.js + node_modules mit,
# public/ und .next/static muss man selbst dazulegen — Next kopiert sie
# bewusst nicht, weil sie in vielen Setups vom CDN kommen. Fehlen sie,
# startet die App und liefert dann 404 auf Logo, Manifest, Service Worker
# und alle CSS-/JS-Chunks: eine nackte, unformatierte Seite.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Healthcheck gegen `/manifest.json`.
#
# ⚠️ Bewusst NICHT gegen eine Seite wie `/kontakt`: die läuft durch
# `proxy.ts`, und der ruft `supabase.auth.getUser()` VOR der
# Public-Route-Prüfung — also bei jedem Request einen Netzwerk-Call zum
# Auth-Server. Ein harter Ausfall wäre folgenlos (der Fehler wird
# verschluckt, die Seite antwortet weiter mit 200 — nachgemessen), aber ein
# LANGSAMER Auth-Server schöbe die Antwort über das 5-s-Timeout: Container
# ungesund, Neustart-Schleife, obwohl die App läuft. Genau dann, wenn ohnehin
# etwas klemmt, wäre das die falsche Reaktion.
#
# `/manifest.json` ist im `config.matcher` von proxy.ts ausgenommen, wird
# also ohne Session-Prüfung direkt vom Node-Server ausgeliefert: der Check
# beantwortet genau die Frage „lebt der Prozess und antwortet er?".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/manifest.json').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
