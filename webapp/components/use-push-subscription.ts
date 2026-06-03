"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/toast-provider";
import { savePushSubscription, deletePushSubscription } from "@/app/profile/push-actions";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type PushStatus =
  | "loading"
  | "unsupported" // Browser kann kein Web-Push
  | "needs-install" // iOS: erst zum Home-Bildschirm hinzufügen
  | "denied" // Permission hart blockiert
  | "subscribed"
  | "unsubscribed";

/** Base64url (VAPID-Public-Key) → Uint8Array für applicationServerKey.
 *  Klassische Fehlerquelle: den rohen String direkt zu übergeben → subscribe() wirft. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
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
      if (!cancelled) setStatus(sub ? "subscribed" : "unsubscribed");
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
      const reg = await navigator.serviceWorker.ready;
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
        await deletePushSubscription(sub.endpoint);
        await sub.unsubscribe().catch(() => {});
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
