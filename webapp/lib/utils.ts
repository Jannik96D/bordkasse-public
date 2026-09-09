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

/**
 * Deutsche Betragseingabe → Zahl. Umkehrung von `formatAmount`, aber
 * toleranter: versteht zusätzlich **Tausenderpunkte**.
 *
 * Warum das nötig ist: die naive Variante `Number(s.replace(",", "."))` macht
 * aus dem Platzhalter-Beispiel „3.700,00" ein `NaN` und — deutlich schlimmer —
 * aus „3.700" die Zahl `3.7`. Genau so eine Eingabe landete als
 * Anzahlungs-Gesamtsumme in der DB: Charter-Soll 3,70 € statt 3.700 €, ohne
 * jede Fehlermeldung.
 *
 * Regeln (bewusst konservativ, damit nichts umgedeutet wird):
 * - Enthält die Eingabe ein Komma, ist das Komma das Dezimaltrennzeichen und
 *   alle Punkte sind Tausenderpunkte: „3.700,50" → 3700.5.
 * - Ohne Komma gilt ein Punkt nur dann als Tausendertrenner, wenn die ganze
 *   Eingabe dem Muster `1.234(.567)*` folgt: „3.700" → 3700, aber „3.7"
 *   bleibt 3.7 (jemand tippt einen Dezimalpunkt) und „3.70" bleibt 3.7.
 *
 * @returns die Zahl, oder `null` bei leerer/unparsbarer Eingabe.
 */
export function parseAmountDe(input: string): number | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  const normalized = s.includes(",")
    ? s.replace(/\./g, "").replace(",", ".")
    : /^\d{1,3}(\.\d{3})+$/.test(s)
      ? s.replace(/\./g, "")
      : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Betrag mit deutschem Dezimalkomma, 2 Nachkommastellen, OHNE Währungszeichen:
 * `47.3` → "47,30". Für Eingabefelder + Beträge, die ihre Einheit separat
 * anzeigen (z. B. "500,00 SEK"). Geteilte Quelle statt vieler Inline-
 * `toFixed(2).replace(".", ",")`-Kopien.
 */
export function formatAmount(n: number): string {
  return n.toFixed(2).replace(".", ",");
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

/**
 * Auf 2 Nachkommastellen runden — halbe Cents VON NULL WEG, exakt wie Postgres
 * `ROUND(numeric, 2)`. `Math.round` rundet halbe Werte Richtung +∞
 * (−10,125 → −10,12), Postgres von Null weg (−10,125 → −10,13); ohne Angleich
 * wich der TS-Mirror (`lib/calc`) bei .xx5-Salden vom SQL ab (Fund C-6). Für
 * positive Beträge identisch zu `Math.round`.
 */
export function round2(n: number): number {
  const cents = n * 100;
  return (Math.sign(cents) * Math.round(Math.abs(cents))) / 100;
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

/**
 * Leitet einen Anzeigenamen aus einer E-Mail ab (Teil vor dem @, getrimmt).
 * Fallback, wenn der Skipper jemanden nur per E-Mail anlegt — die Person
 * kann den Namen später selbst korrigieren. Liefert "" bei leerer Eingabe.
 * Wird in allen Person-Anlage-Pfaden genutzt (inviteMember, createTrip,
 * replaceMember), damit „nur E-Mail" überall funktioniert.
 */
export function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.split("@")[0]?.trim() ?? "";
}
