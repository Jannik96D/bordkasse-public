"use client";

import { Bell, BellOff, BellRing } from "lucide-react";
import { usePushSubscription } from "@/components/use-push-subscription";

/**
 * Profil-Block „Push-Benachrichtigungen". Pro Gerät opt-in. Die eigentliche
 * Logik (Status, Permission, Subscribe/Unsubscribe) steckt im geteilten Hook
 * `usePushSubscription` — derselbe Hook trägt den Übersicht-Nudge.
 */
export function NotificationBlock() {
  const { status, busy, error, enable, disable } = usePushSubscription();

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
