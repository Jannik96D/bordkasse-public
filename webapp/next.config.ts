import type { NextConfig } from "next";

/**
 * Security-Header für die Bordkasse-App.
 *
 * - HSTS:                  Browser merkt sich, dass die Domain nur über HTTPS erreichbar ist.
 * - X-Frame-Options:       Verhindert Einbettung in fremde iframes (Clickjacking).
 * - X-Content-Type-Options: Browser darf Content-Type nicht "raten" → blockiert XSS via falsche MIME.
 * - Referrer-Policy:       Beim Klick auf externe Links keine sensiblen Pfade in Referrer schicken.
 * - Permissions-Policy:    Hardware-APIs (Kamera, Mikro, Geo, …) sind komplett aus.
 * - CSP:                   Erlaubt nur eigene Origin + Supabase. inline/eval bleibt erlaubt,
 *                          weil Next.js + React beides für den Runtime-Bootstrap brauchen.
 *
 * `connect-src` enthält wss://*.supabase.co für Realtime-Subscriptions.
 */
const SUPABASE_HOST = "*.supabase.co";

const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
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
