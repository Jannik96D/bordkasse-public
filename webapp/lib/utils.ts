import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-Class-Merge-Helper für shadcn-Components */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Euro-Format DE: "1.234,56 €" */
export function formatEuro(amount: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Datum-Format DE: ISO "2026-04-05" → "5. Apr. 2026" */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** Kaufmännisch auf 2 Nachkommastellen runden. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aktueller Zeitstempel in Millisekunden. Als Helper gekapselt, damit
 * `Date.now()` nicht direkt im Komponenten-/Effekt-Code steht (die
 * react-hooks/purity-Regel verbietet impure Calls dort).
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Anzahl der (inklusiven) Tage zwischen zwei ISO-Daten YYYY-MM-DD.
 * "ab" und "bis" zählen beide mit (1 Tag = von/bis am selben Tag).
 * Liefert 0 bei leeren Eingaben oder wenn "bis" vor "ab" liegt.
 *
 * Wird sowohl in der Anzahlungs-Berechnung (lib/actions/prepayments.ts) als
 * auch in der client-seitigen Aufteilungs-Vorschau (transaction-form.tsx)
 * gebraucht — daher hier zentral, kein Duplikat.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const diff = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return Math.max(0, diff);
}

/** Heute als ISO-Date YYYY-MM-DD (in lokaler Zeitzone, ohne Zeit). */
export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
