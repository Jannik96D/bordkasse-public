/**
 * Client-seitiges Aufräumen beim Abmelden (Fund 5, PR 5).
 *
 * Vorher gab es dafür GAR KEINEN Code — `signOut()` (app/profile/actions.ts)
 * ist eine reine Server Action, die nur die Supabase-Session beendet. Auf
 * einem geteilten Gerät (Familien-iPad, siehe CLAUDE.md „Push-Benachrichtigungen")
 * blieben damit Service-Worker-Caches (RSC-Payloads/Formulare des vorherigen
 * Nutzers), der Fremdwährungs-Kurscache und ein aktives Push-Abo bestehen.
 *
 * Bewusst NICHT angefasst: die IndexedDB-Outbox. Sie darf nie automatisch
 * geleert werden — noch nicht übertragene Buchungen sind echte Nutzerdaten
 * und ein Verlust wäre eine Doppelbuchung wert (Nutzer würde sie erneut
 * eintippen). Der Aufrufer prüft die Outbox separat (`count()` aus
 * `lib/offline/outbox.ts`) und zeigt einen Hinweis, statt die Einträge
 * anzufassen.
 *
 * Jeder Schritt ist best-effort: ein einzelner fehlschlagender Schritt (z. B.
 * `caches` in einem eingeschränkten Kontext nicht verfügbar) darf das
 * Abmelden nicht verhindern.
 */
"use client";

import { deletePushSubscription } from "@/app/profile/push-actions";
import { clearRateCache } from "@/lib/offline/rate-cache";

async function clearAllCaches(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {
    // Cache-API nicht verfügbar / Zugriff verweigert → nichts zu tun.
  }
}

/**
 * Meldet das Push-Abo DIESES GERÄTS ab, sofern es der gerade abgemeldeten
 * Person gehört. `deletePushSubscription` filtert serverseitig auf die eigene
 * `person_id` — auf einem geteilten Gerät mit fremdem Abo bleibt dieses
 * unangetastet (`deleted: false`), exakt wie in `usePushSubscription().disable()`.
 * MUSS vor dem eigentlichen `signOut()` laufen, da `deletePushSubscription`
 * die aktuelle Session braucht, um den Besitz zu prüfen.
 */
async function unsubscribeOwnPush(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const res = await deletePushSubscription(sub.endpoint);
    if (res.ok && res.deleted) {
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    // Bestes Bemühen — ein hängendes Abo ist unschön, aber kein Datenverlust.
  }
}

/**
 * Räumt Geräte-lokale Spuren der abgemeldeten Person auf: SW-Caches,
 * bekannte localStorage-Schlüssel, eigenes Push-Abo. Wirft NIE — der
 * Aufrufer meldet unabhängig davon ab.
 */
export async function cleanupOnLogout(): Promise<void> {
  await unsubscribeOwnPush();
  await clearAllCaches();
  clearRateCache();
}
