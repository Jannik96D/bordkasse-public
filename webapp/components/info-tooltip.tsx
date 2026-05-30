"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";

/**
 * Kleines ⓘ-Icon, das auf Hover (Desktop) oder Tap (Mobile) eine kurze
 * Erklärung anzeigt. Ersetzt inline-„Hinweis: …"-Texte, die das UI im
 * Standardfall überladen.
 *
 * Verhalten:
 *   - Hover/Focus öffnet das Popover
 *   - Tap auf Mobile toggled es (und blockt die Click-Propagation)
 *   - Klick außerhalb / Esc schließt
 *   - Popover positioniert sich rechts vom Trigger und nach unten;
 *     bei Platzmangel landet es links bzw. oberhalb (via `data-flip`)
 *
 * Wenn der Hinweis länger als 1–2 Sätze ist, gehört er nicht in einen
 * Tooltip — dann lieber `<details>` als Aufklapper benutzen.
 */
export function InfoTooltip({
  text,
  label = "Mehr Info",
}: {
  text: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      // `align-middle` zentriert die 16px-Icon-Box vertikal zum Text;
      // der 1px-Nudge (`-top-px`) korrigiert, dass `vertical-align: middle`
      // zur x-Höhe statt zur optischen Textmitte ausrichtet und das Icon
      // sonst minimal zu tief sitzt. `ml-1` am Button hält den Abstand
      // einheitlich bei 4px — daher InfoTooltip immer DIREKT an den Text
      // hängen (nicht als gap-Flex-Kind, sonst doppelter Abstand).
      className="relative -top-px inline-flex shrink-0 align-middle"
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Explizite Maße via inline-style — manche Browser-Defaults für
        // `<button>` (min-width / min-height) ziehen den Button sonst auf
        // Touch-Target-Größe auf. Fixe 16×16 + box-sizing:border-box halten
        // das Icon kompakt, unabhängig vom Eltern-Layout.
        style={{
          width: 16,
          height: 16,
          minWidth: 16,
          minHeight: 16,
          padding: 0,
          boxSizing: "border-box",
        }}
        className="ml-1 inline-flex shrink-0 items-center justify-center rounded-full text-ink-soft hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-full z-30 mt-1 w-64 -translate-x-1/2 rounded-md border border-rule bg-paper px-3 py-2 text-xs font-normal leading-snug text-ink shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
