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
 */
function configuredOrigin(): string | undefined {
  return process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_ORIGIN;
}

function allowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  const envUrl = configuredOrigin();
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

  const envUrl = configuredOrigin();
  if (envUrl) {
    const o = normalizeOrigin(envUrl);
    if (o) return o;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[bordkasse:origin] Weder NEXT_PUBLIC_SITE_URL noch NEXT_PUBLIC_APP_ORIGIN gesetzt und kein erlaubter Origin-Header — Magic-Link-Versand würde auf localhost zeigen. Bitte eine der beiden Env-Variablen in Vercel setzen.",
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
