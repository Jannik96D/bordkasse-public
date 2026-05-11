"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Berechnet, ob ein Dropdown nach unten oder oben aufgeklappt werden soll,
 * basierend auf dem verfügbaren Viewport-Platz. Liefert auch die maximal
 * nutzbare Höhe, damit die Liste nie über den Viewport-Rand hinausragt.
 *
 * Die fixed-positionierte BottomNav (≈64px) wird abgezogen — sonst läge die
 * Liste unter der Navigation und der Boden wäre nicht erreichbar.
 */
export function useDropdownPosition(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  { bottomReserve = 80, minSpace = 200 }: { bottomReserve?: number; minSpace?: number } = {},
) {
  const [position, setPosition] = useState<{ direction: "down" | "up"; maxHeight: number }>({
    direction: "down",
    maxHeight: 288,
  });

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.innerHeight;
      const spaceBelow = viewport - rect.bottom - bottomReserve;
      const spaceAbove = rect.top - 8;

      if (spaceBelow >= minSpace || spaceBelow >= spaceAbove) {
        setPosition({ direction: "down", maxHeight: Math.max(spaceBelow, 120) });
      } else {
        setPosition({ direction: "up", maxHeight: Math.max(spaceAbove, 120) });
      }
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, triggerRef, bottomReserve, minSpace]);

  return position;
}
