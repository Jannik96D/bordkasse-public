// Bordkasse Service Worker — App-Shell-Caching für Yacht-WiFi-Lücken.
//
// Strategie:
//   - Static Assets (icons, manifest) → CacheFirst, lange Lebensdauer
//   - Same-origin HTML/Page-Navigationen → NetworkFirst, Cache-Fallback,
//     letzter Fallback: vorgecachte /offline.html (markenkonform statt Browser-Dino)
//   - Same-origin RSC-Navigation (Client-Router, Header "RSC: 1", kein Prefetch)
//     → NetworkFirst in eigenen Cache → online besuchte Seiten offline abrufbar
//   - Same-origin _next/static, _next/image → CacheFirst (immutable)
//   - Cross-origin (Supabase API/Realtime) → niemals cachen, normales Fetch
//   - POST/PUT/PATCH/DELETE (Server Actions) → niemals cachen
//
// Update-Flow (WICHTIG): Der Worker ruft NICHT mehr unbedingt skipWaiting() im
// install — eine neue Version bleibt im `waiting`-Zustand, bis der Nutzer im
// "Neue Version verfügbar"-Banner auf "Aktualisieren" tippt (→ SKIP_WAITING-
// Message). So wird die Crew nicht mitten in einer Eingabe weggerissen
// (automatischer Reload-Footgun). clients.claim() bleibt, damit der ERSTE
// Worker die schon offene Seite ohne erzwungenen Reload übernimmt.
//
// Bei jeder Version den CACHE_VERSION-String hochzählen, damit alte
// Caches beim Activate-Event aufgeräumt werden.

const CACHE_VERSION = "bordkasse-v8";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;
const RSC_CACHE = `${CACHE_VERSION}-rsc`;

const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.json",
  "/logo.png",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-icon.png",
  "/badge-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  // KEIN self.skipWaiting() — siehe Update-Flow oben. Der Worker wartet, bis
  // der Nutzer das Update bewusst anstößt (SKIP_WAITING-Message).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Nur GET-Requests cachen.
  if (request.method !== "GET") return;

  // Cross-Origin (Supabase API/Realtime, Resend etc.) → bypass.
  if (url.origin !== self.location.origin) return;

  // _next/static + _next/image sind immutable → CacheFirst.
  if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/_next/image")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Statische Assets im /public-Bereich (svg/png/json/ico).
  if (/\.(svg|png|jpg|jpeg|webp|ico|json|woff2?)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // RSC-Navigation des Client-Routers (Header "RSC: 1", aber KEIN Prefetch) →
  // NetworkFirst in eigenen Cache. So sind online besuchte Seiten (Törn-Auswahl
  // → Törn, Bilanz, Schulden) offline abrufbar. Prefetches (partielle Trees)
  // bewusst NICHT cachen, sonst überschreiben sie die vollständige Navigations-
  // RSC. Die ?_rsc=-Query ist nur Cache-Buster (wird ignoriert).
  if (
    request.headers.get("RSC") === "1" &&
    request.headers.get("Next-Router-Prefetch") !== "1"
  ) {
    event.respondWith(rscNetworkFirst(request));
    return;
  }

  // Page-Navigation → NetworkFirst, Fallback auf Cache, dann Offline-Seite.
  if (request.mode === "navigate" || request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(request, PAGES_CACHE));
    return;
  }

  // Default: einfach durchreichen.
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Fallback ohne Query-String: eine Navigation zu `…/transactions/new?draft=X`
    // soll offline auf das vorgewärmte `…/transactions/new`-Dokument fallen.
    // Die Client-Seite liest `?draft=` und lädt den Entwurf aus IndexedDB.
    const ignoreSearch = await cache.match(request, { ignoreSearch: true });
    if (ignoreSearch) return ignoreSearch;
    // Letzter Fallback für nie besuchte Seiten: markenkonforme Offline-Seite
    // (liegt im STATIC_CACHE, nicht im PAGES_CACHE).
    if (request.mode === "navigate") {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw err;
  }
}

// RSC-Payloads des Client-Routers. NetworkFirst: online immer frisch (und neu
// gecacht), offline die zuletzt geladene RSC dieser URL. Schlüssel ohne die
// volatile ?_rsc=-Query; ignoreVary, weil Next die Antwort u. a. auf RSC /
// Next-Router-State-Tree / Next-Url variiert — wir wollen bewusst die letzte
// Vollnavigation unabhängig vom State-Tree liefern. Cache-Miss offline → der
// Fetch wirft, die offline-bewusste Error-Boundary (app/error.tsx) fängt es ab.
async function rscNetworkFirst(request) {
  const cache = await caches.open(RSC_CACHE);
  const url = new URL(request.url);
  url.searchParams.delete("_rsc");
  const keyUrl = url.toString();
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(keyUrl, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(keyUrl, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

// Triggern eines sofortigen Update-Wechsels per Message vom Client
// ("Aktualisieren"-Button in components/service-worker-register.tsx).
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ── Web-Push ──────────────────────────────────────────────────────────────
// Eingehende Push-Nachricht. Payload = JSON { title, body, url, tag } (siehe
// lib/notify/payloads.ts). Push + Mail gehen immer gemeinsam raus — der Push
// ist der kurze Weckruf, die Mail liefert den Kontext.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Bordkasse", body: event.data.text(), url: "/" };
  }
  const title = payload.title || "Bordkasse";
  const url = payload.url || "/";

  event.waitUntil(
    (async () => {
      // Foreground-Suppression: schaut der Nutzer GERADE auf die betroffene
      // Trip-Seite, hat der Realtime-Toast die Info bereits gezeigt → keine
      // doppelte OS-Benachrichtigung. Ein anderes/gesperrtes Gerät oder ein
      // anderer Trip bekommt den Push trotzdem (die Mail kommt ohnehin immer).
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // alwaysShow umgeht die Suppression (Events OHNE Realtime-Toast-Pendant,
      // z. B. Abrechnung schreibt nur `trips`, das RealtimeTrip nicht abonniert
      // → sonst sähe die fokussierte Crew gar nichts).
      const suppressed =
        !payload.alwaysShow &&
        wins.some((c) => c.visibilityState === "visible" && c.focused && sameTripScope(c.url, url));
      if (suppressed) return;

      await self.registration.showNotification(title, {
        body: payload.body || "",
        tag: payload.tag,
        renotify: Boolean(payload.tag),
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        lang: "de",
        data: { url },
      });
    })(),
  );
});

// Klick auf die Benachrichtigung → bestehendes Fenster fokussieren (und
// dorthin navigieren), sonst ein neues öffnen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  const absolute = new URL(url, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const targetPath = new URL(url, self.location.origin).pathname;

      // 1) Ein Fenster ist bereits exakt auf der Ziel-URL → nur fokussieren.
      for (const client of wins) {
        if ("focus" in client && client.url === absolute) return client.focus();
      }
      // 2) Ein Fenster im selben Trip-Scope → fokussieren und nur navigieren,
      //    wenn der PFAD abweicht (reine Query/Hash-Differenz löst keine
      //    Navigation aus). So wird kein Fenster eines ANDEREN Trips gekapert.
      for (const client of wins) {
        if ("focus" in client && sameTripScope(client.url, url)) {
          await client.focus();
          let clientPath = "";
          try {
            clientPath = new URL(client.url).pathname;
          } catch {
            /* ignorieren */
          }
          if (clientPath !== targetPath && "navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* Fenster lädt gerade — egal, der Nutzer ist in der App */
            }
          }
          return;
        }
      }
      // 3) Sonst ein neues Fenster öffnen.
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

// Gehören zwei URLs zur selben /trips/<id>-Seite? Nur dann unterdrücken wir
// bei sichtbarem Fenster — ein Push zu Trip B darf NICHT verschluckt werden,
// nur weil gerade Trip A offen ist.
function sameTripScope(clientUrl, targetUrl) {
  try {
    const c = new URL(clientUrl, self.location.origin).pathname.match(/^\/trips\/[^/]+/);
    const t = new URL(targetUrl, self.location.origin).pathname.match(/^\/trips\/[^/]+/);
    if (!c || !t) return false; // kein klarer Trip-Bezug → lieber anzeigen
    return c[0] === t[0];
  } catch {
    return false;
  }
}
