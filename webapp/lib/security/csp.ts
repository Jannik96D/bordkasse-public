/**
 * CSP-Bausteine, die von einer Env-Variable abhängen.
 *
 * Bewusst in einem eigenen Modul statt inline in `next.config.ts`: die
 * Ableitung ist testbar und ein Regress hier wäre teuer zu finden. Eine
 * falsche `connect-src`-Direktive blockiert den Browser-Zugriff auf die
 * Datenbank NUR client-seitig — die Seiten rendern weiter (Server
 * Components), aber Realtime verbindet nie und Live-Updates bleiben still
 * aus. Kein Fehler-Toast, keine rote Seite, nur eine Konsolen-Meldung.
 */

/** Cloud-Muster als Rückfallebene (lokale Builds, CI ohne Env-Var). */
const FALLBACK = "https://*.supabase.co wss://*.supabase.co";

/**
 * Zeichen, die in einem CSP-Host-Ausdruck vorkommen dürfen: Buchstaben,
 * Ziffern, Punkt, Bindestrich, Doppelpunkt (Port), Wildcard, Klammern (IPv6).
 *
 * `new URL()` verbietet zwar Leerzeichen im Host — eine *Ausweitung* der CSP
 * durch eine zusätzliche Source ist über die Env-Var also nicht möglich.
 * Aber `;` und `,` sind erlaubte Host-Zeichen (`new URL("https://a;b").host`
 * ergibt `"a;b"`), und beide TRENNEN in einer CSP: `;` beendet die Direktive,
 * `,` die ganze Policy. Ein Tippfehler könnte so unbeabsichtigt eine fremde
 * Direktive anhängen. Deshalb hier eine Positivliste statt Vertrauen.
 */
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]*]+$/;

/**
 * Erlaubte Supabase-Origins für `connect-src`, abgeleitet aus der
 * Supabase-URL.
 *
 * Liefert IMMER beide Schemata für denselben Host: `https://` für die
 * REST-/Auth-Aufrufe und `wss://` für die Realtime-WebSockets. `connect-src`
 * deckt beide NICHT gemeinsam ab — ein fehlendes `wss://` ist genau der
 * Fehler, der Realtime lahmlegt, während alles andere funktioniert.
 *
 * @param rawUrl Wert von NEXT_PUBLIC_SUPABASE_URL (darf fehlen/ungültig sein)
 */
export function supabaseConnectSrc(rawUrl: string | undefined): string {
  if (!rawUrl) return FALLBACK;
  let host: string;
  try {
    // `host` statt `hostname`: ein Port gehört zum CSP-Host-Ausdruck
    // (lokal läuft Supabase auf :54321).
    ({ host } = new URL(rawUrl));
  } catch {
    // Eine kaputte URL nicht durchreichen — das ergäbe eine syntaktisch
    // ungültige Direktive, die der Browser komplett verwirft. Die CSP wäre
    // dann wirkungslos, ohne dass es auffällt.
    return FALLBACK;
  }
  if (!host || !SAFE_HOST.test(host)) return FALLBACK;
  return `https://${host} wss://${host}`;
}
