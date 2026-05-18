/**
 * Origin-Auflösung für Server-Actions, die Magic-Link- oder Einladungs-URLs
 * konstruieren (z. B. `${origin}/auth/callback`).
 *
 * Priorität:
 *   1. Origin-Header der eingehenden Request (Browser sendet ihn auto bei
 *      Server-Actions — typischerweise vorhanden).
 *   2. NEXT_PUBLIC_SITE_URL aus der Env (für Hintergrund-Jobs ohne Request).
 *   3. http://localhost:3000 — nur im Dev-Build.
 *
 * In Production (NODE_ENV=production) ohne Origin-Header UND ohne
 * NEXT_PUBLIC_SITE_URL wird **fail-loud** geworfen — sonst würden Magic-Links
 * auf localhost zeigen und still ins Leere laufen.
 */
export function resolveOrigin(originHeader: string | null): string {
  if (originHeader) return originHeader;
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[bordkasse:origin] NEXT_PUBLIC_SITE_URL fehlt und Origin-Header ist leer — Magic-Link-Versand würde auf localhost zeigen. Bitte Env-Variable in Vercel setzen.",
    );
  }
  return "http://localhost:3000";
}
