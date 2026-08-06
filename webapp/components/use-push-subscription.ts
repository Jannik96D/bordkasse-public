"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/toast-provider";
import { savePushSubscription, deletePushSubscription } from "@/app/profile/push-actions";
import { isIos, isStandalone } from "@/lib/pwa";
import { urlBase64ToUint8Array, vapidKeyMatches } from "@/lib/push/vapid";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type PushStatus =
  | "loading"
  | "unsupported" // Browser kann kein Web-Push
  | "needs-install" // iOS: erst zum Home-Bildschirm hinzufügen
  | "denied" // Permission hart blockiert
  | "subscribed"
  | "stale" // Abo existiert, wurde aber mit einem ALTEN VAPID-Key erzeugt
  | "unsubscribed";

/** Ergebnis eines stillen Erneuerungsversuchs. */
type HealResult = "healed" | "failed" | "not-ours";

/**
 * Ersetzt ein Abo, das mit einem alten VAPID-Key erzeugt wurde, still durch
 * ein frisches.
 *
 * **Zuerst die DB-Zeile löschen, dann erst das Browser-Abo anfassen.** Das ist
 * bewusst so herum und erledigt drei Dinge auf einmal:
 *
 *  1. **Eigentumsnachweis.** `deletePushSubscription` filtert serverseitig auf
 *     die eigene `person_id` und meldet über `deleted`, ob wirklich eine
 *     eigene Zeile getroffen wurde. Auf einem geteilten Gerät (Familien-iPad —
 *     ausdrücklich ein Anwendungsfall) gehört das vorhandene Abo womöglich
 *     jemand anderem. Ohne diese Prüfung würden wir ihm **ohne jede Nutzer-
 *     aktion** sein Abo abmelden und die eigene Person darüberschreiben; seine
 *     DB-Zeile bliebe als Leiche zurück und er bekäme nie wieder etwas.
 *     `disable()` schützt genau davor — der Heilpfad muss es genauso tun.
 *  2. **Keine Waise bei Fehlern.** Ist die Zeile weg, bevor `unsubscribe()`
 *     läuft, hinterlässt jeder spätere Fehlschlag einen konsistenten Zustand:
 *     kein Abo im Browser UND keine Zeile in der DB. Andersherum (löschen zum
 *     Schluss) bliebe bei einem Abbruch nach `unsubscribe()` genau die tote
 *     Zeile stehen, die diese Funktion beseitigen soll — `web-push.ts` räumt
 *     nur 404/410 auf, ein 403 nie.
 *  3. Der Endpoint ist nach `unsubscribe()` ohnehin nicht mehr erreichbar; das
 *     Abo ist in dem Moment tot, unabhängig von der DB-Zeile.
 */
export async function healStaleSubscription(
  reg: ServiceWorkerRegistration,
  oldSub: PushSubscription,
): Promise<HealResult> {
  try {
    // Schritt 1: Zeile löschen — und daran erkennen, ob das Abo uns gehört.
    // `deletePushSubscription` WIRFT NICHT, es liefert {ok:false} zurück
    // (z. B. abgelaufene Session) — deshalb hier das Ergebnis prüfen und
    // nicht bloß ein `.catch()` anhängen.
    const del = await deletePushSubscription(oldSub.endpoint);
    if (!del.ok) {
      console.error("[push] Alte Abo-Zeile konnte nicht entfernt werden:", del.message);
      return "failed";
    }
    if (!del.deleted) {
      // Fremdes Abo auf einem geteilten Gerät — unangetastet lassen.
      return "not-ours";
    }

    // Schritt 2: Browser-Abo tauschen. `subscribe()` mit einem anderen Key
    // wirft `InvalidStateError`, solange das alte noch existiert.
    await oldSub.unsubscribe();
    const fresh = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
    });
    const res = await savePushSubscription(fresh.toJSON(), navigator.userAgent);
    if (!res.ok) {
      await fresh.unsubscribe().catch(() => {});
      return "failed";
    }
    console.info("[push] Abo nach VAPID-Wechsel automatisch erneuert.");
    return "healed";
  } catch (e) {
    console.error("[push] Automatische Erneuerung fehlgeschlagen", e);
    return "failed";
  }
}

/**
 * Merker für „stille Erneuerung ist fehlgeschlagen". Nötig, weil der Status
 * `stale` sonst nur in genau der Sitzung existiert, in der es schiefging: nach
 * einem Reload gibt es kein Abo mehr, der Hook meldete `unsubscribed` — und
 * wer den Nudge irgendwann weggeklickt hat, bekäme nie wieder einen Hinweis
 * und hielte Push weiter für aktiv.
 */
const HEAL_FAILED_KEY = "bk_push_heal_failed";

function markHealFailed(failed: boolean) {
  try {
    if (failed) localStorage.setItem(HEAL_FAILED_KEY, "1");
    else localStorage.removeItem(HEAL_FAILED_KEY);
  } catch {
    /* localStorage kann blockiert sein — dann gilt der Hinweis nur diese Sitzung */
  }
}

function healFailedEarlier(): boolean {
  try {
    return localStorage.getItem(HEAL_FAILED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Geteilte Geräte-Push-Logik für Profil-Block UND Übersicht-Nudge (kein
 * Duplikat). Kapselt Status-Erkennung, Permission-Anfrage (nur auf Klick),
 * Subscribe/Unsubscribe inkl. Server-Persistenz und Toast-Feedback.
 *
 * Eigenheiten:
 *  - Permission wird NUR via enable() (Klick) angefragt — nie beim Laden
 *    (iOS verweigert sonst sofort und dauerhaft).
 *  - iOS liefert Push nur der installierten PWA → Status "needs-install".
 *  - Der Service Worker registriert nur im Production-Build; in `pnpm dev`
 *    ist Push erwartungsgemäß nicht verfügbar.
 */
export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { show } = useToast();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported =
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window &&
        Boolean(VAPID_PUBLIC_KEY);

      if (!supported) {
        if (!cancelled) setStatus(isIos() && !isStandalone() ? "needs-install" : "unsupported");
        return;
      }
      if (isIos() && !isStandalone()) {
        if (!cancelled) setStatus("needs-install");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        if (!cancelled) setStatus("unsubscribed");
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // Kein Abo — aber vielleicht ist zuvor eine Erneuerung gescheitert.
        // Dann weiter `stale` melden, sonst verschwindet der Hinweis nach dem
        // ersten Reload spurlos (und ein weggeklickter Nudge für immer).
        if (!cancelled) setStatus(healFailedEarlier() ? "stale" : "unsubscribed");
        return;
      }

      // Abo vorhanden — stammt es noch vom aktuellen VAPID-Key?
      const matches = vapidKeyMatches(sub.options?.applicationServerKey, VAPID_PUBLIC_KEY);
      if (matches !== false) {
        if (!cancelled) setStatus("subscribed");
        return;
      }

      // Veraltet: still heilen. Die Berechtigung liegt bereits vor (sonst gäbe
      // es kein Abo), und `subscribe()` braucht dann KEINE Nutzer-Geste — die
      // Crew merkt im Normalfall nichts davon. Nur wenn das schiefgeht, zeigen
      // wir einen Hinweis.
      const result = await healStaleSubscription(reg, sub);
      markHealFailed(result === "failed");
      if (!cancelled) {
        // "not-ours": das Abo gehört jemand anderem auf diesem Gerät — für uns
        // gibt es schlicht keins, also der normale Aktivieren-Weg.
        setStatus(result === "healed" ? "subscribed" : result === "failed" ? "stale" : "unsubscribed");
      }
    })().catch(() => {
      if (!cancelled) setStatus("unsupported");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const existing = await navigator.serviceWorker.getRegistration();
      if (!existing) {
        setError("Service Worker nicht aktiv — Push gibt es nur in der installierten App.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "unsubscribed");
        return;
      }
      // serviceWorker.ready resolved NIE, falls eine Registration zwar
      // existiert, aber nie aktiv/controlling wird → 5s-Timeout statt Hänger.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!reg) {
        setError("Service Worker nicht bereit — bitte Seite neu laden und erneut versuchen.");
        return;
      }
      // Liegt noch ein Abo vor, das NICHT nachweislich zum aktuellen Key
      // gehört, wirft `subscribe()` gleich `InvalidStateError` — also vorher
      // abräumen. Bewusst `!== true` statt `=== false`: gibt der Browser
      // `applicationServerKey` gar nicht heraus (Ergebnis `null`), wäre der
      // Nutzer sonst dauerhaft ausgesperrt — jeder Klick liefe in denselben
      // Fehler, ohne Weg zurück außer „Website-Daten löschen".
      // Hier ist das unbedenklich, anders als beim stillen Heilen: enable() ist
      // eine ausdrückliche Nutzeraktion auf diesem Gerät.
      const leftover = await reg.pushManager.getSubscription();
      if (leftover && vapidKeyMatches(leftover.options?.applicationServerKey, VAPID_PUBLIC_KEY) !== true) {
        const staleEndpoint = leftover.endpoint;
        await leftover.unsubscribe().catch(() => {});
        const del = await deletePushSubscription(staleEndpoint);
        if (!del.ok) console.warn("[push] Alte Abo-Zeile blieb stehen:", del.message);
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: TS 5.9 typt Uint8Array generisch (ArrayBufferLike); subscribe()
        // erwartet BufferSource — die Uint8Array erfüllt das zur Laufzeit.
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
      });
      const res = await savePushSubscription(sub.toJSON(), navigator.userAgent);
      if (!res.ok) {
        // DB-Schreiben fehlgeschlagen → Browser-Abo zurücknehmen, damit Gerät
        // und Server konsistent bleiben.
        await sub.unsubscribe().catch(() => {});
        setError(res.message);
        return;
      }
      markHealFailed(false); // Hinweis-Merker wieder abräumen.
      setStatus("subscribed");
      show("Benachrichtigungen auf diesem Gerät aktiviert.", { variant: "success" });
    } catch (e) {
      console.error("[push] enable failed", e);
      setError("Aktivierung fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }, [show]);

  const disable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const res = await deletePushSubscription(sub.endpoint);
        // Browser-Abo NUR kündigen, wenn das Geräte-Abo wirklich dem aktuellen
        // Nutzer gehörte — sonst würde auf einem geteilten Gerät das Abo eines
        // ANDEREN Accounts gekillt (dessen DB-Zeile bliebe als Leiche zurück).
        if (res.ok && res.deleted) {
          await sub.unsubscribe().catch(() => {});
        }
      }
      setStatus("unsubscribed");
      show("Benachrichtigungen auf diesem Gerät deaktiviert.", { variant: "info" });
    } catch (e) {
      console.error("[push] disable failed", e);
      setError("Deaktivierung fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }, [show]);

  return { status, busy, error, enable, disable };
}
