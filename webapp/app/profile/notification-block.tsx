"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { useToast } from "@/components/toast-provider";
import { savePushSubscription, deletePushSubscription } from "./push-actions";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

type Status =
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
 * Profil-Block „Push-Benachrichtigungen". Pro Gerät opt-in.
 *
 * Wichtige Eigenheiten:
 *  - Permission wird NUR auf Klick angefragt (nie beim Laden — iOS verweigert
 *    sonst sofort und dauerhaft).
 *  - iOS liefert Push ausschließlich der installierten PWA → im Safari-Tab
 *    zeigen wir den Installations-Hinweis statt eines toten Buttons.
 *  - Der Service Worker registriert nur im Production-Build; in `pnpm dev`
 *    ist Push erwartungsgemäß nicht verfügbar.
 */
export function NotificationBlock() {
  const [status, setStatus] = useState<Status>("loading");
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
      // iOS verlangt die installierte PWA — im Safari-Tab gibt es kein Push.
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
        // Kein SW (z. B. Dev-Modus) → Aktivieren würde ins Leere laufen.
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
        // DB-Schreiben fehlgeschlagen → Browser-Abo zurücknehmen, damit
        // Gerät und Server konsistent bleiben (sonst „still subscribed",
        // aber Server kennt das Abo nicht).
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

  return (
    <div className="mt-8 border-t border-rule pt-6">
      <h2 className="text-sm font-semibold text-primary">Push-Benachrichtigungen</h2>
      <p className="mt-1 text-xs text-ink-soft">
        Erhalte auf diesem Gerät eine Mitteilung bei Abrechnung, abgehakten Zahlungen und
        fälligen Anzahlungen. Die E-Mail bekommst du zusätzlich immer — die Mitteilung ist nur
        der schnelle Hinweis.
      </p>

      {status === "loading" && <p className="mt-3 text-xs text-ink-soft">Prüfe Gerät …</p>}

      {status === "unsupported" && (
        <p className="mt-3 text-xs text-ink-soft">
          Dein Browser unterstützt keine Push-Benachrichtigungen. Du bekommst weiterhin alle
          E-Mails.
        </p>
      )}

      {status === "needs-install" && (
        <p className="mt-3 text-xs text-ink-soft">
          Auf iPhone/iPad gibt es Mitteilungen nur, wenn du die App über{" "}
          <span className="font-medium text-ink">Teilen → „Zum Home-Bildschirm“</span> installierst
          und von dort öffnest.
        </p>
      )}

      {status === "denied" && (
        <p className="mt-3 text-xs text-ink-soft">
          Mitteilungen sind in den Browser-Einstellungen blockiert. Erlaube sie dort für diese
          Seite, um sie zu aktivieren.
        </p>
      )}

      {status === "unsubscribed" && (
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary hover:text-paper disabled:opacity-60"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {busy ? "Aktiviere …" : "Auf diesem Gerät aktivieren"}
        </button>
      )}

      {status === "subscribed" && (
        <div className="mt-3 space-y-2">
          <p
            className="inline-flex items-center gap-1.5 text-xs font-medium text-success"
            role="status"
          >
            <BellRing className="h-4 w-4" aria-hidden="true" />
            Auf diesem Gerät aktiv.
          </p>
          <div>
            <button
              type="button"
              onClick={disable}
              disabled={busy}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-rule px-4 py-2 text-sm font-medium text-ink-soft hover:border-danger hover:text-danger disabled:opacity-60"
            >
              <BellOff className="h-4 w-4" aria-hidden="true" />
              {busy ? "Deaktiviere …" : "Auf diesem Gerät deaktivieren"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
