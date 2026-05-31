/**
 * Origin-Auflösung für Server-Actions, die Magic-Link- oder Einladungs-URLs
 * konstruieren (z. B. `${origin}/auth/callback`).
 *
 * SICHERHEIT: Der eingehende Origin-Header ist clientseitig frei setzbar
 * (Server-Actions akzeptieren Cross-Origin-POSTs). Würde er ungeprüft in
 * `emailRedirectTo` fließen, könnte ein Angreifer den Magic-Link auf eine
 * fremde Domain lenken und den Auth-Code abgreifen. Deshalb akzeptieren wir
 * den Header nur, wenn er auf einer Allowlist steht (Production-Origin aus
 * NEXT_PUBLIC_SITE_URL + lokale Dev-Hosts).
 *
 * Priorität:
 *   1. Origin-Header — NUR wenn auf der Allowlist.
 *   2. NEXT_PUBLIC_SITE_URL aus der Env.
 *   3. http://localhost:3000 — nur im Dev-Build.
 *
 * In Production ohne erlaubten Origin UND ohne NEXT_PUBLIC_SITE_URL wird
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

function allowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) {
    const o = normalizeOrigin(envUrl);
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

  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) {
    const o = normalizeOrigin(envUrl);
    if (o) return o;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[bordkasse:origin] NEXT_PUBLIC_SITE_URL fehlt und es kam kein erlaubter Origin-Header — Magic-Link-Versand würde auf localhost zeigen. Bitte Env-Variable in Vercel setzen.",
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
  if (!next.startsWith("/")) return fallback;
  // "//host" und "/\host" werden vom Browser als protokoll-relative bzw.
  // externe URL interpretiert.
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
