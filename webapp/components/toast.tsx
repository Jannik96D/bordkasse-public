"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

/**
 * Liest einen `?toast=<key>`-Parameter aus der URL und blendet die passende
 * Erfolgs-Meldung ein. Nach 3,5 s automatisches Ausblenden + URL-Cleanup.
 *
 * Wird per Server-Action-Redirect ausgelöst, z. B.:
 *   redirect(`/trips/${id}/transactions?toast=expense-created`)
 *
 * Neue Keys hier ergänzen:
 */
const MESSAGES: Record<string, string> = {
  "expense-created": "Ausgabe erfasst.",
  "expense-updated": "Ausgabe aktualisiert.",
  "credit-created": "Gutschrift erfasst.",
  "credit-updated": "Gutschrift aktualisiert.",
  "draft-updated": "Entwurf geändert — wird beim nächsten Online-Gehen übertragen.",
  "draft-synced": "Buchung wurde schon übertragen — bitte über die Liste bearbeiten.",
  "draft-syncing": "Buchung wird gerade übertragen — sie erscheint gleich in der Liste und ist dort bearbeitbar.",
  "draft-deleted": "Entwurf verworfen.",
};

export function Toast() {
  const router = useRouter();
  const params = useSearchParams();
  const key = params.get("toast");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!key || !MESSAGES[key]) return;
    // setTimeout 0 verschiebt den Show-State aus dem synchronen Effect-Body —
    // erfüllt den react-hooks/set-state-in-effect Lint-Rule, ohne dass der
    // User die Verzögerung sieht (erstes Paint zeigt opacity-0, dann fade-in).
    const show = setTimeout(() => setVisible(true), 0);
    const hide = setTimeout(() => setVisible(false), 3500);
    // URL aufräumen, damit Reload kein erneutes Toast triggert.
    const cleanup = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("toast");
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    }, 4000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
      clearTimeout(cleanup);
    };
  }, [key, router]);

  if (!key || !MESSAGES[key]) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-0 top-20 z-40 mx-auto flex max-w-sm justify-center px-4 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-success/30 bg-paper px-4 py-3 text-sm shadow-lg">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden />
        <span className="font-medium">{MESSAGES[key]}</span>
      </div>
    </div>
  );
}
