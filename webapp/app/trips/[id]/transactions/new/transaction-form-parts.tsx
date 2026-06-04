"use client";

// Geteilte Bausteine der Buchungs-Form (entflochten aus transaction-form.tsx).
//
// Enthält: Typen, Konstanten/Helfer, die Feld-Hülle `FieldGroup`, das
// `TrancheField`, den Submit-/Offline-/Fehler-Hook `useBookingSubmit`
// (vorher in ExpenseForm + CreditForm dupliziert) sowie die präsentativen
// Blöcke `SharePreview` und `PerPersonAmounts`. So bleibt transaction-form.tsx
// auf das Form-spezifische beschränkt; die fehleranfällige Offline-/
// Idempotency-Logik lebt an EINER Stelle.

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { enqueue, get as getOutboxItem } from "@/lib/offline/outbox";
import { cn, formatEuro, nowMs } from "@/lib/utils";
import { useTripVocab } from "@/components/trip-vocab-provider";
import type { TripVocab } from "@/lib/trip-vocab";
import type { TxState } from "@/lib/actions/transactions";

// ── Typen ───────────────────────────────────────────────────────────────
export type Member = {
  person_id: string;
  display_name: string;
  /** Anwesenheit (für „An Bord" / „Zeitanteilig"-Vorschau). Fällt auf Törn-Daten zurück. */
  on_board_from?: string | null;
  on_board_to?: string | null;
  /** Trinkt Alkohol mit (für Alkoholanteil-Vorschau). */
  is_alcoholic_effective?: boolean;
};
export type Category = { id: string; name: string; icon: string | null };
export type SplitType =
  | "equal"
  | "on_board"
  | "time_proportional"
  | "individual"
  | "per_person";

/** Anzahlungstranche (Migration 0023) — nur Auswahl-Werte für die Form. */
export type TrancheOption = { id: string; label: string; due_date: string };

/** Initialwerte für den Edit-Modus (Ausgabe). */
export type ExpenseInitial = {
  transactionId: string;
  date: string;
  description: string;
  categoryId: string | null;
  paidBy: string;
  amount: number;
  alcoholAmount: number;
  tipAmount: number;
  tipDistribution: "proportional" | "equal";
  splitType: SplitType;
  participantIds: string[];
  participantAmounts: Array<{ personId: string; amount: number }>;
  /** Optional, Migration 0023 — Anzahlungstranche, falls die Buchung zugeordnet ist. */
  trancheId?: string | null;
};

export type CreditInitial = {
  transactionId: string;
  date: string;
  description: string;
  amount: number;
  creditFrom: string;
  /** null = "Alle" */
  creditTo: string | null;
  /** Optional, Migration 0023 — Anzahlungstranche, falls zugeordnet. */
  trancheId?: string | null;
};

// ── Konstanten ──────────────────────────────────────────────────────────
// Reise-typ-abhängige Labels: nur „An Bord"/„Anwesend" hängt am Vokabular,
// die übrigen vier Modi bleiben fix. `splitLabel(vocab)` liefert die volle
// Map (Reihenfolge = Tab-Reihenfolge), `SPLIT_KEYS` die Schlüssel zum Iterieren.
export const SPLIT_KEYS: SplitType[] = [
  "equal",
  "on_board",
  "time_proportional",
  "individual",
  "per_person",
];

export function splitLabel(vocab: TripVocab): Record<SplitType, string> {
  return {
    equal: "Gleichmäßig",
    on_board: vocab.onBoard,
    time_proportional: "Zeitanteilig",
    individual: "Individuell",
    per_person: "Pro Person",
  };
}

/** Sammelhilfe für alle Aufteilungs-Modi — landet im ⓘ-Tooltip. */
export function splitTooltip(vocab: TripVocab): string {
  return (
    "Gleichmäßig: alle teilen sich gleich. " +
    `${vocab.onBoard}: nur am Buchungsdatum anwesende Personen. ` +
    "Zeitanteilig: proportional zu den Bordtagen. " +
    "Individuell: nur explizit markierte Personen. " +
    "Pro Person: jede Person trägt einen eigenen Betrag ein (z. B. Restaurant)."
  );
}

export const idleState: TxState = { status: "idle" };

// Fat-Finger-Schwelle: einzelne Buchungen über diesem Betrag sind selten —
// meist eine Null zu viel. Harte Obergrenze prüft zusätzlich das Zod-Schema.
export const FAT_FINGER_THRESHOLD = 1000;

export const inputCls =
  "mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

// ── Helfer ──────────────────────────────────────────────────────────────
export function formDataToObject(fd: FormData): Record<string, string | string[]> {
  const obj: Record<string, string | string[]> = {};
  for (const [key, val] of fd.entries()) {
    const str = typeof val === "string" ? val : "";
    if (key in obj) {
      const existing = obj[key];
      obj[key] = Array.isArray(existing) ? [...existing, str] : [existing as string, str];
    } else {
      obj[key] = str;
    }
  }
  return obj;
}

/** Number → deutsches Komma-Format für das Input-Feld. */
export function formatAmount(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

export function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

// ── FieldGroup ──────────────────────────────────────────────────────────
export function FieldGroup({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: string;
  /** Feld-spezifische Fehlermeldung — wird direkt unter dem Feld gezeigt. */
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger" role="alert">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>
      )}
    </div>
  );
}

// ── TrancheField (Expense + Credit) ───────────────────────────────────────
export function TrancheField({
  tranches,
  initialTrancheId,
  canEdit,
}: {
  tranches?: TrancheOption[];
  initialTrancheId?: string | null;
  canEdit: boolean;
}) {
  const vocab = useTripVocab();
  const [value, setValue] = useState(initialTrancheId ?? "");
  if (!tranches || tranches.length === 0) return null;
  if (!canEdit) return null;

  return (
    <details open={!!initialTrancheId} className="rounded-md border border-rule bg-paper p-3 text-sm">
      <summary className="cursor-pointer text-ink-soft">
        Anzahlungstranche zuordnen
        {value && <span className="ml-2 text-primary">✓ aktiv</span>}
      </summary>
      <label className="mt-2 block">
        <span className="text-xs text-ink-soft">Tranche</span>
        <select
          name="tranche_id"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded-md border border-rule px-3 py-2"
        >
          <option value="">— Keine ({vocab.kitty}-Pool) —</option>
          {tranches.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({formatDeDate(t.due_date)})
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-ink-soft">
        Wenn gesetzt, zählt die Buchung zur {vocab.prepayment} statt zur laufenden {vocab.kitty}.
      </p>
    </details>
  );
}

// ── useBookingSubmit ──────────────────────────────────────────────────────
// Kapselt die zuvor in ExpenseForm UND CreditForm duplizierte Maschinerie:
// useActionState, idempotency_key, Fehler-Scroll, Fat-Finger-Rückfrage,
// Draft-Überschreiben, Offline-Enqueue und Mid-Flight-Rettung. Verhalten
// 1:1 wie vorher — nur an EINER Stelle.
type BookingKind = "expense" | "credit";
type Action = (prev: TxState, fd: FormData) => Promise<TxState>;

export function useBookingSubmit(opts: {
  tripId: string;
  kind: BookingKind;
  isEdit: boolean;
  isDraft: boolean;
  draftId?: string;
  createAction: Action;
  updateAction: Action;
  /** Aktueller Gesamtbetrag für die Fat-Finger-Rückfrage. */
  getTotal: () => number;
  /** Substantiv für die Rückfrage: „Buchung" | „Gutschrift". */
  fatFingerNoun: string;
}) {
  const { tripId, kind, isEdit, isDraft, draftId, createAction, updateAction, getTotal, fatFingerNoun } = opts;
  const router = useRouter();
  const [state, formAction, pending] = useActionState(isEdit ? updateAction : createAction, idleState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);

  // Bei Validierungs-Fehler: zum betroffenen Feld scrollen + fokussieren.
  useEffect(() => {
    if (state.status !== "error" || !state.field) return;
    const el = document.getElementById(state.field);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  }, [state]);

  // Mid-Flight-Schutz: bricht die Verbindung NACH dem Klick aber VOR dem
  // Redirect ab, in die Outbox retten. Dedup-sicher via idempotency_key.
  useEffect(() => {
    if (isEdit || isDraft || !pending) return;
    const onOffline = () => {
      const form = formRef.current;
      if (!form) return;
      enqueue({
        id: idempotencyKey,
        tripId,
        kind,
        formData: formDataToObject(new FormData(form)),
        createdAt: nowMs(),
      }).catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    };
    window.addEventListener("offline", onOffline);
    return () => window.removeEventListener("offline", onOffline);
  }, [isEdit, isDraft, pending, idempotencyKey, tripId, kind]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Fat-Finger-Schutz: ungewöhnlich hoher Betrag → weiche Rückfrage.
    const total = getTotal();
    if (
      Number.isFinite(total) &&
      total > FAT_FINGER_THRESHOLD &&
      !window.confirm(
        `${formatEuro(total)} ist ungewöhnlich hoch für eine einzelne ${fatFingerNoun}. Stimmt der Betrag?`,
      )
    ) {
      e.preventDefault();
      return;
    }
    // Draft-Modus: Outbox-Eintrag mit gleicher id überschreiben (kein Server-Call).
    // Race-Schutz: ist der Eintrag inzwischen weggesynct, nicht neu einreihen.
    if (isDraft && draftId) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      getOutboxItem(draftId)
        .then((existing) => {
          if (!existing) {
            router.push(`/trips/${tripId}/transactions?toast=draft-synced`);
            return;
          }
          return enqueue({ id: draftId, tripId, kind, formData: obj, createdAt: existing.createdAt }).then(
            () => router.push(`/trips/${tripId}/transactions?toast=draft-updated`),
          );
        })
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
      return;
    }
    if (!isEdit && typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      enqueue({ id: idempotencyKey, tripId, kind, formData: obj, createdAt: nowMs() })
        .then(() => router.push(`/trips/${tripId}/transactions`))
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    }
  };

  const errorField = state.status === "error" ? state.field : undefined;
  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const fieldError = (field: string) => fieldErrors[field];
  const isInvalid = (field: string) => !!fieldErrors[field] || errorField === field;

  return { state, formAction, pending, formRef, handleSubmit, fieldError, isInvalid, idempotencyKey };
}

// ── SharePreview: Live-„Wer zahlt wie viel?" ──────────────────────────────
export function SharePreview({
  preview,
}: {
  preview: { rows: { name: string; share: number }[]; sum: number } | null;
}) {
  if (!preview || preview.rows.length === 0) return null;
  return (
    <details className="rounded-md border border-rule bg-paper-soft p-3 text-sm">
      <summary className="cursor-pointer font-medium text-ink">Wer zahlt wie viel?</summary>
      <ul className="mt-3 space-y-1">
        {preview.rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ink-soft">{r.name}</span>
            <span className="shrink-0 tabular-nums">{formatEuro(r.share)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-rule pt-2 font-medium">
        <span>Summe</span>
        <span className="tabular-nums text-primary">{formatEuro(preview.sum)}</span>
      </div>
    </details>
  );
}

// ── PerPersonAmounts: „Wer zahlt was?" (Pro-Person-Modus) ──────────────────
export type PerPersonRow = {
  personId: string;
  displayName: string;
  raw: string;
  amount: number;
  valid: boolean;
};

export function PerPersonAmounts({
  rows,
  sum,
  onChange,
  error,
  invalid,
}: {
  rows: PerPersonRow[];
  sum: number;
  onChange: (personId: string, value: string) => void;
  error?: string;
  invalid: boolean;
}) {
  return (
    <FieldGroup
      label="Wer zahlt was?"
      error={error}
      hint={
        "Pro Person Betrag eintragen. Rechnen geht auch (z. B. „3 + 17“) — auf dem Smartphone die „?123“-Taste der Tastatur für die Operatoren. Leer = nicht beteiligt."
      }
    >
      <div
        id="participant_amounts"
        tabIndex={-1}
        className={cn(
          "space-y-2 rounded-md border border-rule bg-paper p-3 outline-none",
          invalid && "border-danger ring-2 ring-danger/20",
        )}
      >
        {rows.map((p) => {
          const showEval = p.raw && p.valid && /[+\-*/]/.test(p.raw);
          return (
            <div key={p.personId} className="flex items-center gap-3">
              <label htmlFor={`pp-${p.personId}`} className="min-w-0 flex-1 truncate text-sm">
                {p.displayName}
              </label>
              <div className="flex w-40 flex-col items-end gap-0.5">
                <div className="flex w-full items-center gap-2">
                  {/* inputMode="text" (statt "decimal"), damit Mobile-Tastaturen die
                      Symboltaste für Operatoren erlauben (Rechenausdrücke wie „3+4"). */}
                  <input
                    id={`pp-${p.personId}`}
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={p.raw}
                    onChange={(e) => onChange(p.personId, e.target.value)}
                    placeholder="–"
                    aria-describedby={showEval ? `pp-eval-${p.personId}` : undefined}
                    className={cn(
                      "h-10 w-full rounded-md border bg-paper px-2 text-right text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
                      p.valid ? "border-rule" : "border-danger ring-2 ring-danger/20",
                    )}
                  />
                  <span className="w-4 shrink-0 text-sm text-ink-soft">€</span>
                </div>
                {showEval && (
                  <span id={`pp-eval-${p.personId}`} className="pr-6 text-xs text-ink-soft" aria-live="polite">
                    = {formatAmount(p.amount)} €
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between border-t border-rule pt-2 text-sm font-medium">
          <span>Summe</span>
          <span className="text-primary">{formatEuro(sum)}</span>
        </div>
        {/* JSON-Bundle für FormData. Nur Einträge mit amount > 0. */}
        <input
          type="hidden"
          name="participant_amounts"
          value={JSON.stringify(
            rows.filter((p) => p.amount > 0).map((p) => ({ person_id: p.personId, amount: p.amount })),
          )}
        />
      </div>
    </FieldGroup>
  );
}
