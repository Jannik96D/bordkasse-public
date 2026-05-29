"use client";

import { useEffect, useId, useRef, useState } from "react";

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
    <span ref={wrapperRef} className="relative inline-flex shrink-0 align-middle">
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
        // `<button>` (min-width / padding) überschreiben Tailwind-Utilities
        // und ziehen den Button zu einer Pille auseinander. Mit fixed
        // width/height + box-sizing:border-box bleibt es ein Kreis,
        // unabhängig vom Eltern-Layout (flex-Parent, etc.).
        style={{
          width: 16,
          height: 16,
          minWidth: 16,
          minHeight: 16,
          padding: 0,
          boxSizing: "border-box",
          fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
          lineHeight: 1,
        }}
        className="ml-1 inline-flex shrink-0 items-center justify-center rounded-full border border-rule text-[11px] font-bold text-ink-soft hover:border-primary/40 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        i
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
