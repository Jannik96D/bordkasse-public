"use client";

import { useEffect, useState } from "react";
import { Smartphone, X, Copy, Check } from "lucide-react";
import { isInAppBrowser } from "@/lib/pwa";

const DISMISS_KEY = "bordkasse:inapp-warning-dismissed";

/**
 * Warnt, wenn die App in einem iOS-In-App-Browser (Outlook/Gmail …) läuft.
 * Dort funktioniert Offline-Buchen nicht: WKWebView-Hosts haben oft keinen
 * Service Worker und einen vom Safari-/PWA-Speicher getrennten Cache. Online
 * ist alles normal — der Hinweis zielt nur auf den Einsatz ohne Empfang.
 * „Link kopieren" erleichtert das Öffnen in Safari.
 *
 * Selbst-gated (rendert null außerhalb eines In-App-Browsers) und wegklickbar.
 */
export function InAppBrowserWarning() {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Deferred (Microtask) → kein set-state-in-effect-Lint, kein Aufblitzen.
    Promise.resolve().then(() => {
      try {
        if (localStorage.getItem(DISMISS_KEY) === "1") return;
      } catch {
        /* localStorage blockiert → trotzdem zeigen */
      }
      if (isInAppBrowser()) setShow(true);
    });
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* nur für diese Sitzung ausblenden */
    }
    setShow(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* kein Clipboard-Zugriff → Nutzer kopiert die Adresse manuell */
    }
  };

  return (
    <aside
      role="note"
      className="relative mb-4 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hinweis ausblenden"
        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      <div className="flex items-start gap-3 pr-7">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium text-primary">In einer anderen App geöffnet</p>
          <p className="text-ink-soft">
            Du hast Bordkasse aus einer anderen App (z. B. Outlook) geöffnet. Online
            funktioniert alles — aber <strong>offline</strong> lässt sich hier nichts
            erfassen. Für den Einsatz ohne Empfang: in Safari öffnen (⋯ → „In Safari
            öffnen“) und über das Teilen-Symbol zum Home-Bildschirm hinzufügen.
          </p>
          <button
            type="button"
            onClick={copyLink}
            className="mt-2 inline-flex min-h-touch items-center gap-1.5 rounded-md border border-primary px-3 py-2 font-medium text-primary transition-colors hover:bg-primary hover:text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
          >
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? "Link kopiert" : "Link kopieren"}
          </button>
        </div>
      </div>
    </aside>
  );
}
