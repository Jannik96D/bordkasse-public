/**
 * Client-sichere PWA-/Plattform-Erkennung. Bewusst geteilt von `install-hint`
 * UND dem Push-Hook (`use-push-subscription`), damit die iPad-/Standalone-
 * Erkennung nicht zwischen den beiden divergiert (sie tat es: der Push-Hook
 * verfehlte die iPadOS-Desktop-UA, die install-hint via maxTouchPoints fängt).
 *
 * Alle Funktionen sind SSR-sicher (Guards auf `window`/`navigator`).
 */

/** Läuft die App als installierte PWA (Home-Bildschirm), nicht im Browser-Tab? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari nutzt eine nicht-standardisierte Property.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iPhone, iPod ODER iPad — inkl. iPadOS 13+, das standardmäßig eine
 * Macintosh-Desktop-UA meldet (dann am Touch-Mac erkennbar).
 */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPhone|iPod|iPad/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}
