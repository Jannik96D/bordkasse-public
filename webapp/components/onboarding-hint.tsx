"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * Einmaliger Coachmark, der beim ersten Nutzen während des Törns auf das
 * „+"-FAB zeigt. Die inhaltlichen Trigger (Törn aktiv, Crew vorhanden, noch
 * keine eigene Buchung) prüft der Server und übergibt sie als `eligible`.
 * Hier kommt nur noch die clientseitige Bedingung dazu: pro Törn höchstens
 * einmal (localStorage), und nicht mehr, sobald weggeklickt.
 *
 * Bewusst nicht-modal (role="status", kein Fokus-Klau), respektiert
 * prefers-reduced-motion über die globale CSS-Regel.
 */
export function OnboardingHint({
  tripId,
  eligible,
}: {
  tripId: string;
  eligible: boolean;
}) {
  const storageKey = `bordkasse:onboarded:${tripId}`;
  // Erst nach Mount entscheiden (localStorage ist nur clientseitig verfügbar),
  // damit SSR/CSR nicht divergieren.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!eligible) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(storageKey) === "1";
    } catch {
      // localStorage nicht verfügbar (Privatmodus o. Ä.) → Hinweis einfach zeigen.
    }
    if (dismissed) return;
    // setState asynchron (nicht synchron im Effect-Body) — react-hooks-Regel.
    const t = setTimeout(() => setVisible(true), 0);
    return () => clearTimeout(t);
  }, [eligible, storageKey]);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // ignorieren
    }
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      className="fixed bottom-36 right-4 z-30 max-w-[16rem] rounded-lg border border-primary/30 bg-paper p-3 text-sm shadow-lg"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hinweis schließen"
        className="absolute right-1 top-1 inline-flex h-touch w-touch items-center justify-center rounded-md text-ink-soft hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <p className="pr-6 text-ink">
        Tippe hier unten auf <span className="font-semibold text-primary">➕</span>, um
        eure erste Ausgabe zu erfassen.
      </p>
      {/* Pfeil zum FAB (unten rechts) */}
      <span
        aria-hidden="true"
        className="absolute -bottom-2 right-8 h-4 w-4 rotate-45 border-b border-r border-primary/30 bg-paper"
      />
    </div>
  );
}
