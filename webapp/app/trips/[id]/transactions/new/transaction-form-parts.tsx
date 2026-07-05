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
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { enqueue, get as getOutboxItem } from "@/lib/offline/outbox";
import { isSyncing } from "@/lib/offline/sync";
import { cn, formatEuro, nowMs } from "@/lib/utils";
import { InfoTooltip } from "@/components/info-tooltip";
import { useTripVocab } from "@/components/trip-vocab-provider";
import type { TripVocab } from "@/lib/trip-vocab";
import type { TxState } from "@/lib/actions/transactions";
import { type CurrencyChoice } from "@/lib/rates/options";

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
export type TrancheOption = {
  id: string;
  label: string;
  due_date: string;
  /**
   * Tranchen-Betrag (= Plansumme × Prozent / 100). Dient der Auto-Vorbelegung
   * des Betrag-Felds im Ausgabe-Formular (Charter-Überweisung). Optional, weil
   * ohne Plan/Summe kein Betrag ableitbar ist.
   */
  amount?: number;
};

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
  /** amount = eingegebener Betrag (Fremdbetrag bei Fremdwährung). */
  participantAmounts: Array<{ personId: string; amount: number }>;
  /** Optional, Migration 0023 — Anzahlungstranche, falls die Buchung zugeordnet ist. */
  trancheId?: string | null;
  /** Fremdwährung (Migration 0041) — null/EUR = Euro nativ. */
  originalCurrency?: string | null;
  /** Fremdbetrag (wie auf dem Bon) — bei Fremdwährung das Eingabe-Ausgangsformat. */
  originalAmount?: number | null;
  /** 1 Einheit Fremdwährung = X EUR (der beim Buchen verwendete Kurs). */
  exchangeRate?: number | null;
  rateSource?: "live" | "manual" | "bank" | null;
  /** Tatsächlich von der Bank berechneter Euro-Betrag (nur wenn rate_source='bank'). */
  bankAmount?: number | null;
  /** Voller Fremdbetrag der Kartenzahlung (Privatabzug-Fall). Nur aus einem
   *  Outbox-ENTWURF wiederherstellbar (dort in formData), NICHT aus einer
   *  gespeicherten Server-Buchung (transient) — siehe Fund O-3. */
  bankForeignAmount?: number | null;
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
  /** Fremdwährung (Migration 0041). */
  originalCurrency?: string | null;
  originalAmount?: number | null;
  exchangeRate?: number | null;
  rateSource?: "live" | "manual" | "bank" | null;
  bankAmount?: number | null;
  /** Siehe ExpenseInitial.bankForeignAmount (Fund O-3, nur aus Entwurf). */
  bankForeignAmount?: number | null;
};

// CurrencyChoice ist in @/lib/rates/options definiert (reines Modul, testbar) —
// hier für externe Importeure (draft-editor, edit-page) re-exportiert.
export type { CurrencyChoice };

/** Kurs → deutsches Komma (volle Präzision, kein Runden — kleine Kurse!). */
export function formatRate(n: number): string {
  return String(n).replace(".", ",");
}
/** Kurs-Eingabe → Zahl. Ungültig/≤0 → null. */
export function parseRate(s: string): number | null {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  onSelect,
}: {
  tranches?: TrancheOption[];
  initialTrancheId?: string | null;
  canEdit: boolean;
  /**
   * Wird bei einer BENUTZER-Auswahl (nicht beim initialen Render) mit der
   * gewählten Tranche bzw. `null` („Keine") aufgerufen — das Ausgabe-Formular
   * nutzt das, um Betrag + Beschreibung vorzubelegen.
   */
  onSelect?: (tranche: TrancheOption | null) => void;
}) {
  const vocab = useTripVocab();
  const [value, setValue] = useState(initialTrancheId ?? "");
  if (!tranches || tranches.length === 0) return null;
  if (!canEdit) return null;

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setValue(id);
    onSelect?.(tranches.find((t) => t.id === id) ?? null);
  };

  return (
    <details open={!!initialTrancheId} className="rounded-md border border-rule bg-paper p-3 text-sm">
      {/* Marker, dass das Feld tatsächlich sichtbar gerendert wurde. Der Server
          unterscheidet damit „bewusst auf Keine gesetzt" (Feld da, leer) von
          „Feld gar nicht angezeigt" (nicht berechtigt) und lässt im zweiten
          Fall die bestehende Tranche-Zuordnung unangetastet. */}
      <input type="hidden" name="tranche_field_present" value="1" />
      <summary className="cursor-pointer text-ink-soft">
        Anzahlungstranche zuordnen
        {value && <span className="ml-2 text-primary">✓ aktiv</span>}
      </summary>
      <label className="mt-2 block">
        <span className="text-xs text-ink-soft">Tranche</span>
        <select
          name="tranche_id"
          value={value}
          onChange={handleChange}
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
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);

  // Rettet eine neue Buchung in die Outbox, wenn die Server-Action mit einem
  // Netzwerkfehler ABLEHNT (Fund O-5): totes Uplink-WLAN (Router verbunden,
  // Internet weg) lässt navigator.onLine auf true und feuert KEIN offline-Event
  // — der offline-Listener oben und der Pre-Submit-Gate greifen dann nicht, und
  // die Eingabe fiele sonst in die Error-Boundary. Dedup-sicher über den
  // idempotency_key (ein bereits serverseitig angelegter Insert läuft beim
  // Replay in die Unique-Violation und gilt als Erfolg → kein Duplikat).
  const createWithRescue = useCallback<Action>(
    async (prev, fd) => {
      try {
        return await createAction(prev, fd);
      } catch (err) {
        try {
          await enqueue({ id: idempotencyKey, tripId, kind, formData: formDataToObject(fd), createdAt: nowMs() });
        } catch {
          throw err; // Outbox selbst kaputt → ursprünglichen Fehler zeigen
        }
        router.push(`/trips/${tripId}/transactions`);
        return idleState;
      }
    },
    [createAction, idempotencyKey, tripId, kind, router],
  );

  const [state, formAction, pending] = useActionState(isEdit ? updateAction : createWithRescue, idleState);

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
      // Race-Schutz (Fund O-1): Wird der Eintrag GERADE synchronisiert, darf er
      // nicht überschrieben werden — der Server-Insert mit gleichem
      // idempotency_key gewinnt sonst und die Bearbeitung ginge verloren.
      if (isSyncing(draftId)) {
        router.push(`/trips/${tripId}/transactions?toast=draft-syncing`);
        return;
      }
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
  unit = "€",
}: {
  rows: PerPersonRow[];
  sum: number;
  onChange: (personId: string, value: string) => void;
  error?: string;
  invalid: boolean;
  /** Anzeige-Einheit — bei Fremdwährung der ISO-Code (z. B. „SEK"), sonst „€". */
  unit?: string;
}) {
  const fmtSum = unit === "€" ? formatEuro(sum) : `${formatAmount(sum)} ${unit}`;
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
                  <span className="w-8 shrink-0 text-right text-sm text-ink-soft">{unit}</span>
                </div>
                {showEval && (
                  <span id={`pp-eval-${p.personId}`} className="pr-8 text-xs text-ink-soft" aria-live="polite">
                    = {formatAmount(p.amount)} {unit}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between border-t border-rule pt-2 text-sm font-medium">
          <span>Summe</span>
          <span className="text-primary">{fmtSum}</span>
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

// ── CurrencyField: Währungswahl + Wechselkurs (Migration 0041) ─────────────
// Nur sichtbar, wenn der Törn Fremdwährungen erlaubt. Bei EUR (Default) rendert
// es nur den Währungs-Umschalter, keine Hidden-Inputs → der Server behandelt
// die Buchung als reine Euro-Buchung. Bei Fremdwährung: Kurs-Feld (vorbefüllt,
// editierbar), EUR-Vorschau und die Hidden-Inputs original_currency /
// exchange_rate / rate_source. Der eingegebene Betrag bleibt in Fremdwährung;
// der Server rechnet in EUR um.
export function CurrencyField({
  options,
  currency,
  onCurrencyChange,
  rateInput,
  onRateChange,
  rateSource,
  bankInput,
  onBankChange,
  bankForeignInput,
  onBankForeignChange,
  eurPreview,
  error,
}: {
  options: CurrencyChoice[];
  currency: string;
  onCurrencyChange: (code: string) => void;
  rateInput: string;
  onRateChange: (value: string) => void;
  rateSource: "live" | "last_booking" | "manual" | "bank";
  /** Tatsächlich abgebuchter Euro-Betrag laut Kontoauszug (Eingabe-String). */
  bankInput: string;
  onBankChange: (value: string) => void;
  /** Voller Fremdbetrag der Kartenzahlung — nur nötig, wenn vom Buchungsbetrag abweichend. */
  bankForeignInput: string;
  onBankForeignChange: (value: string) => void;
  /** Resultierender Euro-Betrag (Bank falls gesetzt, sonst Fremd × Kurs). Vom Formular berechnet. */
  eurPreview: number | null;
  error?: string;
}) {
  const isForeign = currency !== "EUR";
  const bankActive = isForeign && parseRate(bankInput) != null;

  const sourceHint = bankActive
    ? "Effektiver Kurs aus dem tatsächlichen Bankbetrag."
    : rateSource === "manual"
      ? "Kurs manuell angepasst."
      : rateSource === "last_booking"
        ? "Offline — Kurs der letzten Buchung dieser Währung. Bitte prüfen."
        : "Tageskurs, automatisch geladen. Du kannst ihn anpassen.";

  // Server-Enum kennt nur live|manual|bank; „last_booking" (Offline-Fallback)
  // wird als „live" abgelegt. Ein eingetragener Bankbetrag gewinnt → 'bank'.
  const submittedSource = bankActive
    ? "bank"
    : rateSource === "manual"
      ? "manual"
      : "live";

  return (
    <div className="space-y-2 rounded-md border border-rule bg-paper p-3">
      <FieldGroup
        label={
          <>
            Währung
            <InfoTooltip
              label="Fremdwährung erklärt"
              text="Gib den Betrag in der Fremdwährung ein — er wird zum Kurs unten automatisch in Euro umgerechnet. Die Abrechnung bleibt in Euro."
            />
          </>
        }
        htmlFor="currency_select"
      >
        <select
          id="currency_select"
          value={currency}
          onChange={(e) => onCurrencyChange(e.target.value)}
          className={cn(inputCls, "py-2")}
        >
          <option value="EUR">Euro (€)</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} — {o.label}
            </option>
          ))}
        </select>
      </FieldGroup>

      {isForeign && (
        <>
          <FieldGroup
            label={
              <>
                {`Wechselkurs (1 ${currency} = € )`}
                <InfoTooltip label="Zum Wechselkurs" text={sourceHint} />
              </>
            }
            htmlFor="exchange_rate_input"
            error={error}
          >
            <input
              id="exchange_rate_input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={rateInput}
              onChange={(e) => onRateChange(e.target.value)}
              placeholder="z. B. 0,0903"
              readOnly={bankActive}
              className={cn(inputCls, bankActive && "bg-paper-soft text-ink-soft")}
            />
          </FieldGroup>
          <p className="text-sm" aria-live="polite">
            {eurPreview != null ? (
              <>
                Ergibt <span className="font-semibold text-primary">{formatEuro(eurPreview)}</span>
              </>
            ) : (
              <span className="text-ink-soft">Bitte einen gültigen Wechselkurs eingeben.</span>
            )}
          </p>

          {/* Echten Bankbetrag nachtragen: was die Bank laut Kontoauszug wirklich
              abgebucht hat (inkl. Gebühren). Überschreibt den geschätzten Kurs.
              Der volle Fremdbetrag ist nur nötig, wenn oben etwas rausgerechnet
              wurde (z. B. Privatkauf) — sonst = Buchungsbetrag. */}
          <details open={bankActive} className="rounded-md border border-rule bg-paper-soft p-2 text-sm">
            <summary className="cursor-pointer text-ink-soft">
              Echten Bankbetrag nachtragen (optional)
              {bankActive && <span className="ml-2 text-primary">✓ Bankbetrag eingetragen</span>}
            </summary>
            <FieldGroup
              label={
                <>
                  Betrag laut Kontoauszug (€)
                  <InfoTooltip
                    label="Zum Kontoauszug-Betrag"
                    text="Was die Bank laut Kontoauszug wirklich abgebucht hat, inklusive Gebühren. Ersetzt den geschätzten Kurs oben."
                  />
                </>
              }
              htmlFor="bank_eur_amount_input"
            >
              <input
                id="bank_eur_amount_input"
                type="text"
                inputMode="text"
                autoComplete="off"
                value={bankInput}
                onChange={(e) => onBankChange(e.target.value)}
                placeholder="z. B. 45,80"
                className={inputCls}
              />
            </FieldGroup>
            <FieldGroup
              label={
                <>
                  {`Voller Fremdbetrag der Kartenzahlung (${currency})`}
                  <InfoTooltip
                    label="Wann ausfüllen?"
                    text="Nur nötig, wenn du oben etwas rausgerechnet hast (z. B. einen Privatkauf) — dann hier der ganze Betrag der Kartenzahlung. Sonst leer lassen."
                  />
                </>
              }
              htmlFor="bank_foreign_amount_input"
            >
              <input
                id="bank_foreign_amount_input"
                type="text"
                inputMode="text"
                autoComplete="off"
                value={bankForeignInput}
                onChange={(e) => onBankForeignChange(e.target.value)}
                placeholder="ganzer Bon-Betrag"
                className={inputCls}
              />
            </FieldGroup>
          </details>

          <input type="hidden" name="original_currency" value={currency} />
          <input type="hidden" name="exchange_rate" value={rateInput} />
          <input type="hidden" name="rate_source" value={submittedSource} />
          <input type="hidden" name="bank_eur_amount" value={bankInput} />
          <input type="hidden" name="bank_foreign_amount" value={bankForeignInput} />
        </>
      )}
    </div>
  );
}
