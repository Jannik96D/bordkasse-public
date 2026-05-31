// Bordkasse Service Worker — App-Shell-Caching für Yacht-WiFi-Lücken.
//
// Strategie:
//   - Static Assets (icons, manifest) → CacheFirst, lange Lebensdauer
//   - Same-origin HTML/Page-Navigationen → NetworkFirst, Cache-Fallback
//   - Same-origin _next/static, _next/image → CacheFirst (immutable)
//   - Cross-origin (Supabase API/Realtime) → niemals cachen, normales Fetch
//   - POST/PUT/PATCH/DELETE (Server Actions) → niemals cachen
//
// Bei jeder Version den CACHE_VERSION-String hochzählen, damit alte
// Caches beim Activate-Event aufgeräumt werden.

const CACHE_VERSION = "bordkasse-v3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;

const PRECACHE_URLS = [
  "/manifest.json",
  "/logo.png",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
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

  // Page-Navigation → NetworkFirst, Fallback auf Cache.
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
    throw err;
  }
}

// Triggern eines Outbox-Sync per Message vom Client.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
