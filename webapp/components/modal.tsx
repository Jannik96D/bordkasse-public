"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Barrierefreier Dialog-Wrapper (WCAG 2.1):
 *  - role="dialog" + aria-modal + aria-labelledby
 *  - Fokus-Trap (Tab/Shift+Tab zirkulieren innerhalb des Dialogs)
 *  - Escape schließt, Klick auf den Backdrop schließt
 *  - Fokus-Restore auf das auslösende Element nach dem Schließen
 *  - Scroll-Lock auf <body>, solange offen
 *
 * Die Kinder bringen ihre eigene Überschrift mit der id aus `labelledBy` mit.
 */
export function Modal({
  onClose,
  labelledBy,
  children,
  className,
  backdropClassName,
}: {
  onClose: () => void;
  labelledBy?: string;
  children: React.ReactNode;
  className?: string;
  /** Override für die Backdrop-Ausrichtung (z. B. Bottom-Sheet auf Mobile). */
  backdropClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables && focusables.length > 0 ? focusables[0] : panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      // Fokus zurück auf den Auslöser (z. B. die angeklickte Matrix-Zelle).
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className={
        backdropClassName ??
        "fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      }
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={
          className ??
          // max-h + overflow: bei eingeblendeter Tastatur auf kleinen Geräten
          // bleibt der Dialog scrollbar, „Speichern" rutscht nicht unter den Fold.
          "flex max-h-[90dvh] w-full max-w-md flex-col overflow-y-auto rounded-lg border border-rule bg-paper p-5 shadow-xl outline-none"
        }
      >
        {children}
      </div>
    </div>
  );
}
