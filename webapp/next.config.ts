import type { NextConfig } from "next";

/**
 * Security-Header für die Bordkasse-App.
 *
 * - HSTS:                  Browser merkt sich, dass die Domain nur über HTTPS erreichbar ist.
 * - X-Frame-Options:       Verhindert Einbettung in fremde iframes (Clickjacking).
 * - X-Content-Type-Options: Browser darf Content-Type nicht "raten" → blockiert XSS via falsche MIME.
 * - Referrer-Policy:       Beim Klick auf externe Links keine sensiblen Pfade in Referrer schicken.
 * - Permissions-Policy:    Hardware-APIs (Kamera, Mikro, Geo, …) sind komplett aus.
 * - CSP:                   Erlaubt nur eigene Origin + Supabase.
 *
 * `connect-src` enthält wss://*.supabase.co für Realtime-Subscriptions.
 *
 * script-src-Härtung (S-4): In PRODUKTION fällt `'unsafe-eval'` weg — der
 * produktive Next.js-Bundle braucht kein eval() (nur Turbopack/HMR im Dev-
 * Modus tut das). Das schließt eval/Function-basierte XSS-Gadgets aus.
 *
 * `'unsafe-inline'` bleibt: Der Next.js App Router gibt auf JEDER Seite
 * Inline-Skripte aus (RSC-Payload `self.__next_f.push(...)`). Diese ohne
 * 'unsafe-inline' zu erlauben ginge nur per Per-Request-Nonce — die kann
 * aber NICHT in statisch vorgerenderte Seiten (/login, /about, /datenschutz,
 * /kontakt) gebacken werden; deren Skripte hätten keine Nonce und würden
 * von `strict-dynamic` blockiert. Ein nonce-Ansatz würde also erzwingen,
 * jede (auch künftige) öffentliche Seite dynamisch zu rendern — ein stiller
 * Breakage-Footgun. Daher bewusst beim 'unsafe-inline'-Fallback bleiben.
 */
const isProd = process.env.NODE_ENV === "production";
const SUPABASE_HOST = "*.supabase.co";

const scriptSrc = isProd
  ? `script-src 'self' 'unsafe-inline'`
  : `script-src 'self' 'unsafe-inline' 'unsafe-eval'`;

const csp = [
  `default-src 'self'`,
  scriptSrc,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:`,
  `font-src 'self' data:`,
  `connect-src 'self' https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
  `frame-ancestors 'self'`,
  `form-action 'self'`,
  `base-uri 'self'`,
  `object-src 'none'`,
  `manifest-src 'self'`,
  `worker-src 'self' blob:`,
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  /**
   * Client-Router-Cache (Performance): besuchte Törn-Tabs bleiben 30 s im
   * Browser wiederverwendbar. Das Hin- und Herwechseln zwischen
   * Übersicht/Buchungen/Bilanz/Schulden/Statistik ist dann sofort, ohne
   * erneuten Server-Roundtrip. `dynamic` greift, weil unsere Nav-Links
   * (components/bottom-nav.tsx) kein explizites `prefetch` setzen; Next
   * behandelt alle Törn-Seiten als dynamisch (Cookie-Auth → kein Prerender).
   *
   * Sicher für die Finanzdaten: `router.refresh()` (RealtimeTrip bei Änderung
   * durch andere Crew) UND `revalidatePath` (eigene Schreib-Actions) verwerfen
   * diesen Cache sofort — die 30 s greifen nur für reines Navigieren ohne
   * zwischenzeitliche Mutation. `static` (= prefetch={true}) bleibt auf dem
   * Next-Default von 300 s, damit explizite Prefetches sich nicht ändern.
   */
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
