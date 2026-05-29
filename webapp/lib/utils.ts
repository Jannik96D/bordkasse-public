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

/** Heute als ISO-Date YYYY-MM-DD (in lokaler Zeitzone, ohne Zeit). */
export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
