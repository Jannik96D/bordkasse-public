"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { usePushSubscription } from "@/components/use-push-subscription";

const DISMISS_KEY = "bk_push_nudge_dismissed";

/**
 * Dezenter Hinweis-Banner auf der Törn-Übersicht, der Push genau dort
 * anbietet, wo die Crew ohnehin ist — damit die Funktion nicht in den
 * Profil-Einstellungen vergessen wird.
 *
 * Erscheint NUR, wenn das Gerät Push kann und noch nicht abonniert ist
 * (`status === "unsubscribed"`). Aktiviert per Inline-Tap (kein Umweg ins
 * Profil), verschwindet nach Erfolg automatisch und lässt sich wegklicken
 * (in localStorage gemerkt → kein Genörgel bei jedem Besuch). Für nicht
 * unterstützte Geräte / iOS-ohne-Installation bleibt er still — dort erklärt
 * der Profil-Block den Weg, ohne die Übersicht zuzumüllen.
 */
export function NotificationNudge() {
  const { status, busy, error, enable } = usePushSubscription();
  // Default „weggeklickt", bis localStorage gelesen ist → kein Aufblitzen.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let active = true;
    // Deferred (Microtask) statt synchron im Effect → vermeidet
    // react-hooks/set-state-in-effect (gleicher Kniff wie im Hook).
    Promise.resolve().then(() => {
      if (!active) return;
      try {
        setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
      } catch {
        setDismissed(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // `stale` = Abo existiert noch vom alten VAPID-Key und die stille Erneuerung
  // im Hook ist fehlgeschlagen. Anderer Text (die Crew hatte Push ja bereits
  // aktiviert) und bewusst NICHT wegklickbar-vergessen: der Dismiss-Key gilt
  // nur für die Erst-Einladung, sonst bliebe ein totes Abo unbemerkt.
  const isStale = status === "stale";
  if (!isStale && (dismissed || status !== "unsubscribed")) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* localStorage kann blockiert sein — dann nur für diese Sitzung ausblenden */
    }
    setDismissed(true);
  }

  return (
    <section className="mt-4 flex items-start gap-3 rounded-lg border border-primary/30 bg-navy-light/30 p-4">
      <Bell className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary">
          {isStale ? "Benachrichtigungen neu aktivieren" : "Benachrichtigungen aktivieren"}
        </p>
        <p className="mt-0.5 text-xs text-ink-soft">
          {isStale
            ? "Die Benachrichtigungen auf diesem Gerät sind nach einer Server-Umstellung ungültig geworden. Ein Tap genügt — E-Mails kommen unverändert an."
            : "Sofort Bescheid bei Abrechnung und fälligen Zahlungen — auf diesem Gerät, zusätzlich zur E-Mail."}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {busy ? "Aktiviere …" : "Aktivieren"}
        </button>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hinweis ausblenden"
        className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
