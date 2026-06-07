"use client";

import { useEffect, useState } from "react";
import { Share, Smartphone, X, Download } from "lucide-react";
import { isIos, isStandalone, isInAppBrowser } from "@/lib/pwa";

// `BeforeInstallPromptEvent` ist (noch) nicht in den Standard-DOM-Lib-Typen.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * Zeigt einen Hinweis, wie die Bordkasse als PWA auf dem Home-Screen
 * installiert wird. Drei Varianten:
 *   - Chrome/Android (oder Desktop-Chrome): fängt das `beforeinstallprompt`-
 *     Event ab und bietet einen Ein-Tipp-„Installieren"-Button (ruft den
 *     nativen Prompt) — statt die Crew durchs Browser-Menü zu schicken.
 *   - iOS (iPhone/iPad): Schritt-für-Schritt-Anleitung mit Teilen-Symbol
 *     (Safari feuert kein `beforeinstallprompt`).
 *   - Android ohne (noch) gefeuertes Event: textueller Menü-Hinweis als Fallback.
 *
 * Versteckt sich automatisch, wenn das Gerät weder iOS noch Android ist und
 * kein Install-Event kam, die App schon als PWA läuft, in einem iOS-In-App-
 * Browser läuft (dort lässt sich nichts installieren), oder weggeklickt wurde.
 *
 * `dismissKey` ist überschreibbar, damit derselbe Hinweis an verschiedenen
 * Stellen (Startseite vs. innerhalb eines Törns) unabhängig wegklickbar ist.
 */
export function InstallHint({
  dismissKey = "bordkasse:install-hint-dismissed",
}: { dismissKey?: string } = {}) {
  const [show, setShow] = useState(false);
  const [variant, setVariant] = useState<"ios" | "android">("android");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Bereits als PWA installiert → nichts zeigen (geteilte Erkennung mit dem
    // Push-Hook, damit iPad-/Standalone-Logik nicht divergiert).
    if (isStandalone()) return;
    // In einem iOS-In-App-Browser (Outlook/Gmail …) lässt sich gar keine PWA
    // installieren → die Anleitung wäre irreführend. Dort übernimmt die
    // InAppBrowserWarning („in Safari öffnen").
    if (isInAppBrowser()) return;

    // Vom User weggeklickt
    if (localStorage.getItem(dismissKey) === "1") return;

    const iosDevice = isIos();
    const isAndroid = /Android/i.test(window.navigator.userAgent);

    // beforeinstallprompt (Chrome/Android/Desktop-Chrome): den nativen
    // Mini-Infobar abfangen und stattdessen unseren eigenen Button anbieten.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVariant("android");
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // Nach erfolgreicher Installation ausblenden + merken.
    const onInstalled = () => {
      setShow(false);
      try {
        localStorage.setItem(dismissKey, "1");
      } catch {
        // ignorieren
      }
    };
    window.addEventListener("appinstalled", onInstalled);

    // setTimeout 0 verschiebt den Show-State aus dem Effect-Body — erfüllt
    // react-hooks/set-state-in-effect ohne UX-Auswirkung. iOS: Anleitung.
    // Android ohne Event: textueller Fallback.
    let t: ReturnType<typeof setTimeout> | undefined;
    if (iosDevice || isAndroid) {
      t = setTimeout(() => {
        setVariant(iosDevice ? "ios" : "android");
        setShow(true);
      }, 0);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (t) clearTimeout(t);
    };
  }, [dismissKey]);

  const dismiss = () => {
    localStorage.setItem(dismissKey, "1");
    setShow(false);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    try {
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") dismiss();
    } catch {
      // ignorieren
    }
    setDeferredPrompt(null);
  };

  if (!show) return null;

  return (
    <aside
      role="note"
      className="relative mb-6 rounded-md border border-primary/20 bg-gold-soft/40 p-4 text-sm"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hinweis ausblenden"
        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3 pr-7">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium text-primary">Bordkasse als App installieren</p>
          {variant === "ios" ? (
            <ol className="list-decimal space-y-0.5 pl-4 text-ink-soft">
              <li>In Safari öffnen (Chrome/Firefox unterstützen es auf iOS nicht).</li>
              <li>
                Auf das Teilen-Symbol{" "}
                <Share className="inline h-3.5 w-3.5 align-text-bottom" aria-hidden /> in der
                Adressleiste tippen.
              </li>
              <li>Im Menü nach unten scrollen → <strong>„Zum Home-Bildschirm“</strong>.</li>
              <li>Bestätigen → das Icon erscheint wie eine App.</li>
            </ol>
          ) : deferredPrompt ? (
            <>
              <p className="text-ink-soft">
                Mit einem Tipp installieren — landet wie eine echte App auf dem Startbildschirm.
              </p>
              <button
                type="button"
                onClick={install}
                className="mt-2 inline-flex min-h-touch items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-paper transition-colors hover:bg-navy-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
              >
                <Download className="h-4 w-4" aria-hidden />
                Installieren
              </button>
            </>
          ) : (
            <p className="text-ink-soft">
              Auf Android: Browser-Menü (⋮) → <strong>„App installieren“</strong> bzw. „Zum
              Startbildschirm hinzufügen“.
            </p>
          )}
          <p className="pt-1 text-xs text-ink-soft">
            Funktioniert dann offline und merkt sich Buchungen, bis du wieder Empfang hast.
          </p>
        </div>
      </div>
    </aside>
  );
}
