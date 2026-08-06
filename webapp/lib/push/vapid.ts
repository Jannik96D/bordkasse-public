/**
 * Reine VAPID-Hilfen für den Client — bewusst OHNE Import von Server-Actions,
 * damit die Logik in Vitest testbar bleibt (`use-push-subscription.ts` zieht
 * über `push-actions` den `server-only`-Client herein und ist deshalb im Test
 * nicht importierbar).
 */

/**
 * Base64url (VAPID-Public-Key) → Uint8Array für `applicationServerKey`.
 *
 * Klassische Fehlerquelle: den rohen String direkt an `subscribe()` geben —
 * das wirft.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Wurde dieses Abo mit dem AKTUELLEN VAPID-Key erzeugt?
 *
 * `null` = nicht feststellbar (Browser gibt `applicationServerKey` nicht
 * heraus, oder es ist gar kein Key konfiguriert). Dann bewusst NICHTS tun: ein
 * vorhandenes Abo bei jedem Laden vorsorglich neu anzulegen wäre schlimmer als
 * ein möglicherweise totes.
 *
 * Hintergrund: Werden die VAPID-Keys gewechselt, bleiben bestehende Abos
 * technisch bestehen — der Push-Dienst weist den Versand aber mit **403** ab.
 * Und 403 ist genau der Fall, den `lib/notify/web-push.ts` NICHT aufräumt (es
 * löscht nur bei 404/410). Ohne diese Prüfung blieben tote Abos für immer in
 * der DB stehen und jede Zustellung liefe ins Leere, ohne dass es auffällt.
 */
export function vapidKeyMatches(
  subscriptionKey: ArrayBuffer | null | undefined,
  currentKey: string | undefined,
): boolean | null {
  if (!subscriptionKey || !currentKey) return null;
  let expected: Uint8Array;
  try {
    expected = urlBase64ToUint8Array(currentKey);
  } catch {
    // `atob` wirft bei einem verstümmelten Key (Tippfehler/abgeschnitten beim
    // Eintragen in die Env). Ohne dieses Fangnetz flöge der Fehler bis in den
    // Effekt-Catch des Hooks und JEDES Gerät meldete „Browser unterstützt kein
    // Push" — eine Diagnose, die auf den Browser zeigt statt auf die Env.
    console.error("[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY ist kein gültiges base64url.");
    return null;
  }
  const actual = new Uint8Array(subscriptionKey);
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}
