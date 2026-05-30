"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * About-Seite: Screenshot mit Tap-to-Lightbox.
 *
 * Standardansicht zeigt das Bild beschnitten (`object-cover object-top`,
 * max-h-[440px]), damit die Karten kompakt bleiben. Tap öffnet ein
 * Vollbild-Modal mit dem unbeschnittenen Bild.
 *
 * Esc oder Klick außerhalb schließt; body-scroll wird im offenen Zustand
 * gesperrt, damit der Hintergrund nicht mitscrollt.
 */
export function FeatureShot({
  src,
  alt,
}: {
  src: string;
  alt: string;
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 block w-full overflow-hidden rounded-lg border border-rule bg-paper-soft focus:outline-none focus:ring-2 focus:ring-primary/30"
        aria-label={`${alt} — Vollbild anzeigen`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="block max-h-[440px] w-full object-cover object-top"
        />
      </button>

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
