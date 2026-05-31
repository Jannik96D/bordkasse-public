"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Globaler Client-Toast — für Feedback, das NICHT über einen Redirect läuft
 * (Schulden-Abhaken, Realtime-Hinweis, Mail-Teilfehler). Der URL-getriebene
 * `components/toast.tsx` bleibt parallel für Redirect-Flows bestehen.
 *
 * a11y:
 *  - Host ist `role="status"` + `aria-live="polite"` → Screenreader liest neue
 *    Meldungen vor, ohne den Fokus zu stehlen.
 *  - Auto-Dismiss nach ~4 s, aber pausiert bei Hover/Focus (WCAG 2.2.1 —
 *    der User darf eine Meldung in Ruhe lesen / wegklicken).
 *  - Schließen-Button pro Toast (Tastatur erreichbar).
 */

export type ToastVariant = "success" | "error" | "info";

type Toast = {
  id: string;
  message: string;
  variant: ToastVariant;
};

type ShowOptions = { variant?: ToastVariant; durationMs?: number };

type ToastContextValue = {
  show: (message: string, opts?: ShowOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

const VARIANT_STYLE: Record<
  ToastVariant,
  { border: string; icon: typeof CheckCircle2; iconColor: string }
> = {
  success: { border: "border-success/30", icon: CheckCircle2, iconColor: "text-success" },
  error: { border: "border-danger/40", icon: AlertTriangle, iconColor: "text-danger" },
  info: { border: "border-primary/30", icon: Info, iconColor: "text-primary" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Monotone ID ohne Math.random()/Date.now() (purity-Regel) — Ref-Zähler.
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: string, opts?: ShowOptions) => {
    const id = `t${(counter.current += 1)}`;
    const toast: Toast = { id, message, variant: opts?.variant ?? "info" };
    setToasts((prev) => [...prev, toast]);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-4 z-[60] mx-auto flex max-w-sm flex-col items-stretch gap-2 px-4"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const style = VARIANT_STYLE[toast.variant];
  const Icon = style.icon;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), DEFAULT_DURATION);
    return () => clearTimeout(timer);
  }, [paused, toast.id, onDismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex items-center gap-2 rounded-md border bg-paper px-4 py-3 text-sm shadow-lg",
        style.border,
      )}
    >
      <Icon className={cn("h-5 w-5 shrink-0", style.iconColor)} aria-hidden />
      <span className="min-w-0 flex-1 font-medium">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Meldung schließen"
        className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Liefert `show(message, { variant })`. Außerhalb des Providers ein No-Op
 * (statt Throw) — robuster für Komponenten, die in Tests ohne Provider
 * gerendert werden.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return ctx ?? { show: () => {} };
}
