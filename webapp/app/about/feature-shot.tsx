"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * About-Seite: Screenshot in einem schlanken, modernen Phone-Frame.
 *
 * Der Frame zeigt den Screenshot vollständig (kein Crop) im aktuellen
 * iPhone-Seitenverhältnis (Bilder sind 780×1688 ≈ 0,462). Bewusst
 * minimal-flach gehalten — dünne, gleichmäßige Bezels, große Eckenradien,
 * on-brand dunkler Rahmen (kein reines Schwarz), dezente Seiten-Tasten.
 * KEINE Notch/Dynamic-Island: würde Inhalt verdecken und schneller
 * veraltet wirken (vgl. Apples flache 2D-Marketing-Frames).
 *
 * Tap öffnet eine Vollbild-Lightbox zum Reinzoomen. Esc oder Klick
 * außerhalb schließt; body-scroll wird im offenen Zustand gesperrt.
 */
export function FeatureShot({
  src,
  alt,
  priority = false,
}: {
  src: string;
  alt: string;
  /** Erstes sichtbares Bild (LCP) eager + hochpriorisiert laden statt lazy. */
  priority?: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${alt} — Vollbild anzeigen`}
          className="group relative w-full max-w-[248px] rounded-[2rem] bg-ink p-[9px] shadow-[0_18px_40px_-16px_rgba(17,72,132,0.45)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_50px_-16px_rgba(17,72,132,0.55)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {/* Seiten-Tasten — dezenter Realismus, gleiche Farbfamilie wie der Rahmen */}
          <span
            aria-hidden="true"
            className="absolute -left-[2px] top-[88px] h-7 w-[3px] rounded-l bg-ink-soft/60"
          />
          <span
            aria-hidden="true"
            className="absolute -left-[2px] top-[124px] h-10 w-[3px] rounded-l bg-ink-soft/60"
          />
          <span
            aria-hidden="true"
            className="absolute -right-[2px] top-[104px] h-12 w-[3px] rounded-r bg-ink-soft/60"
          />

          {/* Screen */}
          <span className="block overflow-hidden rounded-[1.5rem] bg-paper">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              className="block w-full"
            />
          </span>
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/85 p-4 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Schließen"
            className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-paper/95 text-ink shadow-lg hover:bg-paper focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-full rounded-lg border border-rule bg-paper shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
