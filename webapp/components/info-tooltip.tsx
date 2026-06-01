"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
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
 *   - Popover ist mittig über dem Trigger und wird beim Öffnen gemessen:
 *     ragt es über den Bildschirmrand, wird es horizontal so verschoben,
 *     dass es mit 8px Rand komplett sichtbar bleibt (wichtig auf Mobile,
 *     wenn der Trigger nah am linken Rand sitzt).
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
  const buttonRef = useRef<HTMLButtonElement>(null);

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
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        // Hover NUR bei echter Maus öffnen/schließen. Auf Touch feuern Browser
        // synthetische mouseenter-/focus-Events VOR dem Click; öffneten sie das
        // Popover, würde der direkt folgende Click es sofort wieder zuklappen
        // → man müsste zweimal tippen. Über Pointer-Events ignorieren wir Touch
        // hier komplett (pointerType !== "mouse"); der Tap toggelt allein per
        // onClick. Tastatur öffnet via Enter/Space (löst ebenfalls click aus);
        // bewusst KEIN Öffnen on focus, da sich Tastatur-Focus nicht
        // zuverlässig vom Touch-Focus unterscheiden lässt.
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setOpen(false);
        }}
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
      {open && <TooltipBubble id={id} text={text} triggerRef={buttonRef} />}
    </span>
  );
}

/**
 * Die eigentliche Sprechblase. Wird nur gerendert, solange offen — dadurch
 * starten Mess-Status (`shiftX`/`positioned`) bei jedem Öffnen frisch, ohne
 * Reset-Effekt. Bis zur ersten Messung unsichtbar (`opacity-0`), damit nichts
 * kurz an der mittigen (evtl. überlaufenden) Stelle aufblitzt.
 */
function TooltipBubble({
  id,
  text,
  triggerRef,
}: {
  id: string;
  text: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const tipRef = useRef<HTMLSpanElement>(null);
  const [shiftX, setShiftX] = useState(0);
  const [positioned, setPositioned] = useState(false);

  useEffect(() => {
    function position() {
      const btn = triggerRef.current;
      const tip = tipRef.current;
      if (!btn || !tip) return;
      const margin = 8;
      const btnRect = btn.getBoundingClientRect();
      const centerX = btnRect.left + btnRect.width / 2;
      const halfW = tip.offsetWidth / 2;
      const left = centerX - halfW;
      const right = centerX + halfW;
      let dx = 0;
      if (left < margin) dx = margin - left;
      else if (right > window.innerWidth - margin) dx = window.innerWidth - margin - right;
      setShiftX(dx);
      setPositioned(true);
    }
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [triggerRef]);

  return (
    <span
      ref={tipRef}
      id={id}
      role="tooltip"
      // Volle Transform inline, damit die Mittel-Zentrierung (-50%) mit der
      // Viewport-Korrektur (shiftX) in EINEM Wert steht. `max-w` deckt sehr
      // schmale Geräte ab, auf denen 16rem zu breit wären.
      style={{
        transform: `translateX(calc(-50% + ${shiftX}px))`,
        maxWidth: "calc(100vw - 1rem)",
      }}
      className={`absolute left-1/2 top-full z-30 mt-1 w-64 rounded-md border border-rule bg-paper px-3 py-2 text-xs font-normal leading-snug text-ink shadow-lg transition-opacity ${positioned ? "opacity-100" : "opacity-0"}`}
    >
      {text}
    </span>
  );
}
