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

/**
 * Läuft die App in einem In-App-Browser (Outlook/Gmail/Facebook …) auf iOS?
 * Dort ist Offline-Buchen praktisch unmöglich: WKWebView-Hosts haben oft gar
 * keinen Service Worker, und ihr Speicher ist vom Safari-/PWA-Speicher getrennt
 * — gewärmter Cache und Offline-Outbox aus der installierten App sind hier
 * nicht sichtbar. Genau dieser Fall (Link aus Outlook) ist die häufigste
 * Ursache des „Du bist offline"-Dead-Ends auf iPhones.
 *
 * Bewusst auf iOS beschränkt (nur dort ist es das Problem). Heuristik:
 *  - bekannte App-Tokens in der UA (Facebook/Instagram/Line/Google-App/…),
 *  - sonst: fehlt `serviceWorker` in `navigator`, ist es fast sicher ein
 *    WKWebView-Host (echtes Mobile-Safari hat ihn). Falsch-Positiv möglich im
 *    Safari-Privatmodus — die Empfehlung („in Safari öffnen / installieren") ist
 *    dort aber unschädlich.
 */
export function isInAppBrowser(): boolean {
  if (!isIos()) return false;
  if (isStandalone()) return false; // installierte PWA ist nie „in-app"
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|Instagram|Line\/|Twitter|GSA\/|OKApp|MicroMessenger/i.test(ua)) return true;
  if (!("serviceWorker" in navigator)) return true;
  return false;
}

/**
 * Kann dieser Kontext überhaupt offline arbeiten? Ehrlicher Gate für
 * „funktioniert offline"-Texte: braucht einen Service Worker und darf kein
 * iOS-In-App-Browser sein.
 */
export function supportsOffline(): boolean {
  if (typeof navigator === "undefined") return false;
  return "serviceWorker" in navigator && !isInAppBrowser();
}
