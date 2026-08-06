/**
 * Origin-Auflösung für Server-Actions, die Magic-Link- oder Einladungs-URLs
 * konstruieren (z. B. `${origin}/auth/callback`).
 *
 * SICHERHEIT: Der eingehende Origin-Header ist clientseitig frei setzbar
 * (Server-Actions akzeptieren Cross-Origin-POSTs). Würde er ungeprüft in
 * `emailRedirectTo` fließen, könnte ein Angreifer den Magic-Link auf eine
 * fremde Domain lenken und den Auth-Code abgreifen. Deshalb akzeptieren wir
 * den Header nur, wenn er auf einer Allowlist steht (Production-Origin aus
 * NEXT_PUBLIC_SITE_URL bzw. NEXT_PUBLIC_APP_ORIGIN + lokale Dev-Hosts).
 *
 * Priorität:
 *   1. Origin-Header — NUR wenn auf der Allowlist.
 *   2. NEXT_PUBLIC_SITE_URL, ersatzweise NEXT_PUBLIC_APP_ORIGIN aus der Env.
 *      Beide halten denselben Origin-Wert; APP_ORIGIN wird ohnehin von den
 *      Mail-Templates genutzt. Der Fallback verhindert, dass ein vergessenes
 *      SITE_URL den Magic-Link-/Invite-Versand komplett lahmlegt (genau das
 *      ist in Prod passiert).
 *   3. http://localhost:3000 — nur im Dev-Build.
 *
 * In Production ohne erlaubten Origin UND ohne beide Env-Variablen wird
 * **fail-loud** geworfen.
 */

/** Normalisiert auf scheme://host:port (ohne Pfad/Trailing-Slash). null bei ungültiger URL. */
function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Konfigurierter App-Origin aus der Env. NEXT_PUBLIC_SITE_URL hat Vorrang,
 * NEXT_PUBLIC_APP_ORIGIN ist der Fallback (gleicher Wert, von den Mail-
 * Templates genutzt) — so genügt es, eine der beiden Variablen zu setzen.
 *
 * Es gewinnt der erste Wert, der sich auch **parsen** lässt — bewusst nicht
 * bloß der erste nicht-leere:
 *
 *   - Ein LEERER String muss übersprungen werden, weil im Docker-Build (siehe
 *     Dockerfile/Coolify) ein nicht übergebener `ARG` beim `ENV`-Befehl zu `""`
 *     wird statt zu `undefined` (wie es eine fehlende Var auf Vercel war).
 *     `??` fällt gegen `""` nicht zurück und ließ deshalb den Magic-Link-
 *     Versand trotz korrekt gesetzter APP_ORIGIN abstürzen (Coolify-Cutover).
 *   - Ein UNPARSBARER Wert muss ebenfalls übersprungen werden: ein vergessenes
 *     Schema (`bordkasse.dieter.ms` statt `https://…`) passiert den `test -n`-
 *     Guard im Dockerfile, würde aber die korrekt gesetzte zweite Variable
 *     verdecken — die Allowlist bliebe leer und der Login stürbe komplett,
 *     obwohl eine gültige Konfiguration vorliegt.
 */
function configuredOrigin(): string | undefined {
  for (const candidate of [process.env.NEXT_PUBLIC_SITE_URL, process.env.NEXT_PUBLIC_APP_ORIGIN]) {
    if (candidate && normalizeOrigin(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Kanonische Produktions-Domain. Letzter Notnagel für Links in E-Mails, wenn
 * beide Env-Variablen fehlen: eine falsche absolute URL ist im Mail-Client
 * immer noch besser als ein relativer Pfad, der gar nicht klickbar ist.
 */
const FALLBACK_ORIGIN = "https://bordkasse.dieter.ms";

/**
 * Absoluter App-Origin für Links in E-Mails (Logo-Bild, CTA-Buttons).
 *
 * Anders als `resolveOrigin` gibt es hier keinen Request-Kontext — Mails
 * entstehen auch im Cron. Bewusst ohne Wurf: eine kaputte Env darf keine
 * Abrechnungs-Mail verhindern.
 *
 * ⚠️ Diese Funktion ersetzt das früher an sieben Stellen kopierte
 * `process.env.NEXT_PUBLIC_APP_ORIGIN ?? "…"`. Der `??`-Ausdruck war im
 * Docker-Build kaputt (ein nicht übergebener `ARG` wird beim `ENV`-Befehl zum
 * LEEREN String, gegen den `??` nicht zurückfällt) — Ergebnis wären relative,
 * im Mail-Client tote Links gewesen. Zudem prüft der Dockerfile-Guard nur, ob
 * EINE der beiden Variablen gesetzt ist; wer nur `NEXT_PUBLIC_SITE_URL` setzt,
 * hätte alle Mail-Links verloren, während der Login weiter funktionierte.
 */
export function appOrigin(): string {
  const configured = configuredOrigin();
  if (configured) {
    // normalizeOrigin schneidet zugleich einen Trailing-Slash ab, der sonst
    // zu doppelten Slashes in jedem Mail-Link führt.
    const normalized = normalizeOrigin(configured);
    if (normalized) return normalized;
  }
  // Ohne Env außerhalb von Production auf den lokalen Server zeigen: sonst
  // verweisen Mails, die man lokal auslöst (Abrechnung, Reminder — sie landen
  // im Mailpit), auf die LIVE-Installation. Zwei der ersetzten Aufrufstellen
  // hatten dafür früher eine offensichtlich tote Domain als Fallback.
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  return FALLBACK_ORIGIN;
}

/** Schema der Request-URL (`http`/`https`), null wenn unparsbar. */
function requestScheme(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;
  try {
    return new URL(requestUrl).protocol.replace(":", "");
  } catch {
    return null;
  }
}

/**
 * Origin aus den Host-Headern des Requests. Traefik/Coolify setzen
 * `x-forwarded-host`/`-proto`; der Node-Standalone-Server selbst kennt nur
 * seine Listen-Adresse (`0.0.0.0:3000`), weshalb `new URL(request.url).origin`
 * dort unbrauchbar ist.
 *
 * ⚠️ Das Schema NICHT pauschal auf `https` setzen: ohne Reverse-Proxy (lokaler
 * Dev-Server, Test am Handy über die LAN-IP) schickt der Browser einen `Host`-,
 * aber keinen `x-forwarded-proto`-Header. Ein `https`-Default erzeugte dann
 * einen Redirect auf `https://192.168.x.x:3000` gegen einen Klartext-Server →
 * `ERR_SSL_PROTOCOL_ERROR`, und der Single-Use-Token wäre schon verbraucht.
 * Deshalb: `https` nur annehmen, wenn wirklich ein Proxy-Header vorliegt,
 * sonst das Schema der Request-URL übernehmen.
 */
function forwardedOrigin(headers: Headers, requestUrl?: string): string | null {
  // `||` (nicht `??`): ein VORHANDENER, aber leerer `x-forwarded-host` ist ein
  // leerer String und muss auf den `Host`-Header zurückfallen — sonst gäbe
  // `forwardedOrigin` null zurück und die Host-Prüfung in
  // `requestMayRedeemToken` wäre stillschweigend ausgeschaltet (fail-open in
  // genau der Funktion, die fail-closed sein soll).
  const forwardedHost = headers.get("x-forwarded-host");
  const host = forwardedHost || headers.get("host");
  if (!host) return null;

  // Mehrfach-Proxy: "https,http" → nur den ersten Wert nehmen.
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const proto = forwardedProto || (forwardedHost ? "https" : requestScheme(requestUrl) ?? "http");
  const firstHost = host.split(",")[0].trim();
  return normalizeOrigin(`${proto}://${firstHost}`);
}

/**
 * Origin für Redirects in den Auth-Route-Handlern (`/auth/verify`,
 * `/auth/callback`).
 *
 * Bewusst NICHT `resolveOrigin`: das wirft in Production fail-loud, was beim
 * VERSAND eines Magic-Links richtig ist (lieber kein Link als ein Link auf
 * localhost), beim KLICK aber einen nackten 500 erzeugt — Route-Handler
 * rendern keine `error.tsx`, der Nutzer verlöre die „Neuen Link senden"-
 * Rettung.
 *
 * Bewusst auch NICHT `new URL(request.url).origin`: hinter Traefik liefert das
 * `0.0.0.0:3000`, und der Redirect zeigt auf eine Adresse, die kein Browser
 * aufrufen kann.
 *
 * Reihenfolge:
 *   1. Forwarded-/Host-Header, NUR wenn auf der Allowlist — hält Redirect-Ziel
 *      und Session-Cookie auf demselben Host (sonst setzt `verifyOtp` das
 *      Cookie auf Host A, während der Redirect auf Host B zeigt: der Nutzer
 *      landet ausgeloggt und der Single-Use-Token ist verbraucht).
 *   2. Origin-Header, wenn auf der Allowlist.
 *   3. Außerhalb von Production: der Request-Host ungeprüft — nur so
 *      funktioniert der Test am echten Handy über die LAN-IP
 *      (http://192.168.x.x:3000), die nie auf der Allowlist steht.
 *   4. Env-Origin.
 *   5. Letzter Notnagel ohne Wurf: der Host des Requests (siehe Begründung
 *      unten am Code) — die Request-URL wäre hier das bekannte `0.0.0.0:3000`
 *      und damit unbrauchbar.
 */
export function resolveRedirectOrigin(headers: Headers, requestUrl: string): string {
  const forwarded = forwardedOrigin(headers, requestUrl);

  // Host-basiert nachschlagen, kanonischen Origin zurückgeben — siehe
  // allowedOriginForHost. Ein `http`-Forwarded (Proxy ohne x-forwarded-proto)
  // darf denselben Host nicht verfehlen wie der Token-Guard, der ihn zulässt.
  const fromForwarded = allowedOriginForHost(hostOf(forwarded ?? ""));
  if (fromForwarded) return fromForwarded;

  const originHeader = headers.get("origin");
  const fromOrigin = allowedOriginForHost(hostOf(originHeader ?? ""));
  if (fromOrigin) return fromOrigin;

  if (process.env.NODE_ENV !== "production" && forwarded) return forwarded;

  const envUrl = configuredOrigin();
  if (envUrl) {
    const o = normalizeOrigin(envUrl);
    if (o) return o;
  }

  console.error(
    "[bordkasse:origin] Kein erlaubter Host-/Origin-Header und weder NEXT_PUBLIC_SITE_URL noch NEXT_PUBLIC_APP_ORIGIN brauchbar (fehlt oder ohne Schema) — Auth-Redirect nutzt den Host des Requests.",
  );
  // Notnagel: der Host, über den der Request tatsächlich kam. Das ist die
  // einzige Adresse, die der Browser erreichen kann UND auf der das
  // Session-Cookie landet.
  //
  // Kein Open-Redirect-Risiko: der Wert ist der Host, den der Browser selbst
  // angesprochen hat (ein Angreifer kann den `Host` einer fremden Navigation
  // nicht setzen), und dieser Zweig greift nur bei komplett kaputter Env.
  // Bewusst NICHT `FALLBACK_ORIGIN`: das ist die Domain DIESER Installation —
  // in einem Fork würde der Nutzer nach erfolgreichem Login (Cookie liegt auf
  // dem richtigen Host!) auf eine fremde Domain geschickt, im Fehlerfall sogar
  // mit seiner E-Mail-Adresse im Query-String.
  if (forwarded) return forwarded;
  return normalizeOrigin(requestUrl) ?? FALLBACK_ORIGIN;
}

/**
 * `host[:port]` einer URL (kleingeschrieben, ohne Schema). null bei ungültig —
 * insbesondere bei `Origin: null` (Sandbox-iframe, `data:`-URL).
 */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    // Trailing-Dot der FQDN-Schreibweise (`example.com.`) abschneiden: sonst
    // wäre derselbe Host formal ein anderer und der Login würde abgewiesen.
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    // Default-Ports abschneiden — und zwar SCHEMA-UNABHÄNGIG. `new URL()` tut
    // das nur passend zum eigenen Schema (`https://h:443` → `h`, aber
    // `http://h:443` → `h:443`). Da wir Hosts über Schema-Grenzen hinweg
    // vergleichen (das Schema ist hinter dem Proxy unzuverlässig), muss
    // `:443`/`:80` in beiden Richtungen wegfallen — sonst sperrt ein Proxy,
    // der den Port in `x-forwarded-host` schreibt, die ganze Crew aus.
    const port = url.port === "80" || url.port === "443" ? "" : url.port;
    return port ? `${hostname}:${port}` : hostname;
  } catch {
    return null;
  }
}

/** Hosts der Allowlist — Vergleichsbasis ohne Schema, siehe requestMayRedeemToken. */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const origin of allowedOrigins()) {
    const host = hostOf(origin);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Der allowlistete Origin zu einem Host — oder null, wenn der Host nicht
 * freigegeben ist.
 *
 * Der Vergleich läuft über den Host, zurückgegeben wird aber der KANONISCHE
 * Origin aus der Env (also mit dem dort konfigurierten Schema). Sonst entstünde
 * genau der Riss, den `requestMayRedeemToken` verhindern soll: der Guard lässt
 * einen Request durch, weil der Host stimmt (Schema und Trailing-Dot sind ihm
 * egal), während der Redirect-Origin exakt verglichen wird, danebengeht und den
 * Nutzer nach erfolgreichem `verifyOtp` auf einen anderen Host schickt —
 * ausgeloggt, Token verbraucht.
 */
function allowedOriginForHost(host: string | null): string | null {
  if (!host) return null;
  for (const origin of allowedOrigins()) {
    if (hostOf(origin) === host) return origin;
  }
  return null;
}

/**
 * Darf dieser Request einen Auth-Token einlösen?
 *
 * Hintergrund sind zwei Fehlerbilder, die beide den **Single-Use-Token
 * verbrennen**, bevor irgendwer merkt, dass etwas schiefläuft:
 *
 *   1. **Falscher Host.** Kommt der Request über eine Domain, die nicht auf der
 *      Allowlist steht (Coolify-Ersatzdomain, alte Domain, direkte Server-IP),
 *      setzt `verifyOtp` das Session-Cookie host-gebunden auf DIESE Domain,
 *      während der Redirect auf die kanonische Domain zeigt. Der Nutzer landet
 *      ausgeloggt auf `/login`, der Token ist weg, und jeder neue Link endet
 *      genauso — von außen sieht das wie „Link sofort abgelaufen" aus.
 *   2. **Login-CSRF.** `/auth/verify` ist ein POST ohne CSRF-Token, der eine
 *      Session ausstellt. Ein Angreifer kann sich einen Magic-Link für das
 *      EIGENE Konto schicken lassen und das Opfer per Auto-Submit-Formular von
 *      `evil.com` auf `/auth/verify` posten: das Opfer wäre dann im Konto des
 *      Angreifers eingeloggt und würde dort Buchungen erfassen. Ein
 *      Cross-Origin-POST trägt einen fremden `Origin`-Header — den weisen wir
 *      hier ab (fehlt der Header ganz, wird er nicht verlangt: das ist bei
 *      manchen Clients legitim, und der Host-Check greift weiterhin).
 *
 * ⚠️ Verglichen wird **nur der Host**, nicht das volle Origin. Das Schema ist
 * hinter einem TLS-terminierenden Proxy die unzuverlässigste Angabe: fehlt
 * `x-forwarded-proto` (oder spricht der Proxy intern http), entstünde ein
 * `http://…`, das gegen eine `https://…`-Allowlist nie matcht — und ein
 * Fehlalarm hier sperrt die GESAMTE Crew vom Login aus. Für den Schutzzweck
 * genügt der Host: die Cookie-Bindung ist host-basiert, und ein Angreifer kann
 * keine Inhalte unter der echten Domain ausliefern.
 *
 * Außerhalb von Production immer `true` — sonst wäre der Test am Handy über die
 * LAN-IP unmöglich. Ist die Allowlist leer (Env kaputt), ebenfalls `true`:
 * dann ist ohnehin nichts verlässlich prüfbar, und ein zusätzlicher Block würde
 * nur den Login endgültig unmöglich machen.
 */
export function requestMayRedeemToken(headers: Headers, requestUrl: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;

  const allowed = allowedHosts();
  if (allowed.size === 0) return true;

  const forwarded = forwardedOrigin(headers, requestUrl);
  const forwardedHost = forwarded ? hostOf(forwarded) : null;
  if (forwardedHost && !allowed.has(forwardedHost)) return false;

  const originHeader = headers.get("origin");
  if (originHeader) {
    // `Origin: null` (Sandbox-iframe, data:-URL) ist KEIN erlaubter Wert und
    // fällt hier durch `hostOf` auf null — also blocken.
    const host = hostOf(originHeader);
    if (!host || !allowed.has(host)) return false;
  }

  return true;
}

function allowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  // BEIDE Env-Werte aufnehmen, nicht nur den Gewinner aus `configuredOrigin`:
  // die beiden Variablen SOLLEN denselben Origin tragen, erzwungen ist das
  // aber nirgends. Trägt z. B. NEXT_PUBLIC_SITE_URL eine veraltete Domain und
  // NEXT_PUBLIC_APP_ORIGIN die aktuelle, bestünde die Allowlist sonst nur aus
  // der veralteten — und der Token-Guard sperrte die gesamte Crew aus.
  for (const candidate of [process.env.NEXT_PUBLIC_SITE_URL, process.env.NEXT_PUBLIC_APP_ORIGIN]) {
    if (!candidate) continue;
    const o = normalizeOrigin(candidate);
    if (o) allowed.add(o);
  }
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:3000");
    allowed.add("http://127.0.0.1:3000");
  }
  return allowed;
}

export function resolveOrigin(originHeader: string | null): string {
  const allowed = allowedOrigins();

  if (originHeader) {
    const normalized = normalizeOrigin(originHeader);
    if (normalized && allowed.has(normalized)) return normalized;
    // Nicht-erlaubter Origin → ignorieren und auf die Env zurückfallen.
  }

  const envUrl = configuredOrigin();
  if (envUrl) {
    const o = normalizeOrigin(envUrl);
    if (o) return o;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[bordkasse:origin] Weder NEXT_PUBLIC_SITE_URL noch NEXT_PUBLIC_APP_ORIGIN gesetzt und kein erlaubter Origin-Header — Magic-Link-Versand würde auf localhost zeigen. Bitte eine der beiden Env-Variablen in der Coolify-App-Ressource setzen (als Build Variable, siehe docs/self-hosting.md).",
    );
  }
  return "http://localhost:3000";
}

/**
 * Open-Redirect-Schutz für Post-Login-`next`-Parameter. Erlaubt nur interne,
 * absolute Pfade. Wehrt `https://evil.com`, `//evil.com` und Backslash-Tricks
 * (`/\evil.com`) ab, die `new URL(next, origin)` sonst als externe URL auflöst.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback = "/",
): string {
  if (!next) return fallback;

  // ⚠️ ZUERST die Zeichen entfernen, die der URL-Parser selbst entfernt, sonst
  // ist die Prüfung wertlos: `new URL()` streicht Tab, LF und CR ÜBERALL aus
  // der Eingabe und trimmt führende/abschließende Steuerzeichen. `/<Tab>/evil.com`
  // beginnt also mit einem einzelnen `/` (Prüfung unten bestanden), wird beim
  // Auflösen aber zu `https://evil.com/` — ein Open-Redirect auf genau der
  // Response, die die frische Session setzt. Der Wert kommt aus `?next=` bzw.
  // dem Formularfeld auf /auth/confirm; `%09` wird von `searchParams` in einen
  // echten Tab dekodiert, ist also nicht durch Prozent-Kodierung entschärft.
  const cleaned = next
    .replace(/[\t\n\r]/g, "")
    // C0-Steuerzeichen und Leerzeichen am Rand: die trimmt der URL-Parser.
    // eslint-disable-next-line no-control-regex
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");

  if (!cleaned.startsWith("/")) return fallback;
  // "//host" und "/\host" werden vom Browser als protokoll-relative bzw.
  // externe URL interpretiert.
  if (cleaned.startsWith("//") || cleaned.startsWith("/\\")) return fallback;
  return cleaned;
}
