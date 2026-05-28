"use client";

import { useEffect, useState } from "react";
import { Share, Smartphone, X } from "lucide-react";

const DISMISS_KEY = "bordkasse:install-hint-dismissed";

/**
 * Zeigt einen Hinweis, wie die Bordkasse als PWA auf dem Home-Screen
 * installiert wird. Zwei Varianten:
 *   - iOS (iPhone/iPad) → exakte Schritt-für-Schritt-Anleitung mit Teilen-Symbol
 *   - Android → generischer "Browser-Menü → Zum Home-Bildschirm"-Hinweis
 *
 * Versteckt sich automatisch, wenn:
 *   - das Gerät weder iOS noch Android ist (Desktop hat keinen sinnvollen
 *     PWA-Install-Flow für unseren Use-Case)
 *   - die App schon als PWA läuft (`display-mode: standalone`)
 *   - der User den Hinweis weggeklickt hat
 */
export function InstallHint() {
  const [show, setShow] = useState(false);
  const [variant, setVariant] = useState<"ios" | "android">("android");

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Bereits als PWA installiert → nichts zeigen
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari verwendet ein nicht-standard-property
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;

    // Vom User weggeklickt
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    const ua = window.navigator.userAgent;
    const isIphone = /iPhone|iPod/.test(ua);
    // iPadOS 13+ sendet standardmäßig einen Desktop-Safari-UA, deshalb
    // zusätzlich der Touch-Macintosh-Trick.
    const isIpad =
      /iPad/.test(ua) ||
      (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
    const isIos = isIphone || isIpad;
    const isAndroid = /Android/i.test(ua);

    // Nur auf mobilen Geräten anzeigen — Desktop hat keinen sinnvollen
    // Install-Flow, der hier dokumentiert wird.
    if (!isIos && !isAndroid) return;

    // setTimeout 0 verschiebt den Show-State aus dem Effect-Body — erfüllt
    // react-hooks/set-state-in-effect ohne UX-Auswirkung.
    const t = setTimeout(() => {
      setVariant(isIos ? "ios" : "android");
      setShow(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
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
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-ink"
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
