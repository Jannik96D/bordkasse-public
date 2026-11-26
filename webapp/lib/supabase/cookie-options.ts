import { allowedOriginForHost, hostOf } from "@/lib/auth/origin";

/**
 * Cookie-Optionen für die Supabase-Session (Sicherheitsrunde 2026-11, Slice 13).
 *
 * Ohne eigene Optionen setzt `@supabase/ssr` die Session-Cookies ohne `Secure`
 * (400 Tage, `SameSite=Lax`, `Path=/`). Wir setzen nur `secure` zusätzlich und
 * lassen alles andere beim Default:
 *   - `httpOnly` bleibt AUS — der Browser-Client (Realtime, Token-Refresh)
 *     liest und schreibt die Cookies per `document.cookie`.
 *   - `sameSite` bleibt Lax — der Magic-Link-Klick kommt aus dem Mail-Client
 *     (Top-Level-Navigation), `Strict` würde den Login brechen.
 *   - `maxAge` bleibt bei 400 Tagen — die Sitzungsdauer steuert GoTrue
 *     (Inaktivitäts-Timeout), nicht die Cookie-Lebensdauer.
 *
 * ⚠️ `secure` NIE pauschal an: der LAN-Test am Handy läuft über `http://<IP>`,
 * und ein `Secure`-Cookie würde dort vom Browser verworfen → Login unmöglich.
 * Deshalb serverseitig nur, wenn der Request-Host auf der Allowlist steht UND
 * deren kanonischer Origin `https` ist (die LAN-IP steht nie darauf).
 */
export type SessionCookieOptions = { secure: boolean };

/** Server: Entscheidung anhand der Request-Header (Host hinter dem Proxy). */
export function sessionCookieOptions(headers: Headers): SessionCookieOptions {
  const raw = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0].trim();
  // hostOf erwartet eine URL; das Schema ist für den Host-Vergleich egal.
  const host = raw ? hostOf(`https://${raw}`) : null;
  const origin = allowedOriginForHost(host);
  return { secure: !!origin && origin.startsWith("https:") };
}

/** Browser: Secure nur auf einer https-Seite (auf http würde der Browser das Cookie verwerfen). */
export function browserCookieOptions(): SessionCookieOptions {
  return {
    secure: typeof location !== "undefined" && location.protocol === "https:",
  };
}
