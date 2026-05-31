"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronDown, ChevronUp, Check } from "lucide-react";
import {
  createExpense,
  createCredit,
  updateExpense,
  updateCredit,
  type TxState,
} from "@/lib/actions/transactions";
import { enqueue } from "@/lib/offline/outbox";
import { todayIso, cn, formatEuro, nowMs } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
import { InfoTooltip } from "@/components/info-tooltip";
import { PersonSelect } from "@/components/person-select";
import { safeMathEval } from "@/lib/utils/math-eval";

type Member = { person_id: string; display_name: string };
type Category = { id: string; name: string; icon: string | null };
type SplitType =
  | "equal"
  | "on_board"
  | "time_proportional"
  | "individual"
  | "per_person";

const SPLIT_LABEL: Record<SplitType, string> = {
  equal: "Gleichmäßig",
  on_board: "An Bord",
  time_proportional: "Zeitanteilig",
  individual: "Individuell",
  per_person: "Pro Person",
};

/**
 * Eine kompakte Sammelhilfe für alle Aufteilungs-Modi — landet im Tooltip
 * neben der „Aufteilung"-Überschrift, damit das Standard-Form nicht für
 * jeden Tab eine eigene Hilfezeile rendern muss.
 */
const SPLIT_TOOLTIP =
  "Gleichmäßig: alle teilen sich gleich. " +
  "An Bord: nur am Buchungs-Datum anwesende Personen. " +
  "Zeitanteilig: proportional zu den Bord-Tagen. " +
  "Individuell: nur explizit markierte Personen. " +
  "Pro Person: jede Person trägt einen eigenen Betrag ein (z. B. Restaurant).";

const idleState: TxState = { status: "idle" };

// Schwelle für die Fat-Finger-Rückfrage: einzelne Bordkasse-Buchungen über
// diesem Betrag sind selten — meist eine Null zu viel. Harte Obergrenze
// (1 Mio) prüft zusätzlich das Zod-Schema serverseitig.
const FAT_FINGER_THRESHOLD = 1000;

/** Initialwerte für den Edit-Modus. */
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
  /** Optional, Migration 0023 — Anzahlungs-Tranche, falls die Buchung zugeordnet ist. */
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
  /** Optional, Migration 0023 — Anzahlungs-Tranche, falls zugeordnet. */
  trancheId?: string | null;
};

function formDataToObject(fd: FormData): Record<string, string | string[]> {
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

/** Formatiert eine Number als deutsches Komma-Format für das Input-Feld. */
function formatAmount(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/** Anzahlungs-Tranche (Migration 0023) — nur Auswahl-Werte für die Form. */
export type TrancheOption = { id: string; label: string; due_date: string };

interface TransactionFormProps {
  tripId: string;
  isSkipper: boolean;
  members: Member[];
  categories: Category[];
  /** Törn-Start/-Ende (ISO) — begrenzt das Datums-Feld (min/max) gegen Eingaben außerhalb des Törns. */
  tripStart?: string;
  tripEnd?: string;
  /** person_id des eingeloggten Users — wird im "Bezahlt von"-Dropdown nach oben sortiert. */
  currentPersonId?: string;
  /**
   * Verfügbare Anzahlungs-Tranchen des Trips. Wenn ≥ 1, blendet die Form
   * ein „Anzahlungs-Tranche zuordnen"-Feld ein. Sonst (kein Plan) bleibt das
   * Feld verborgen und die Buchung landet wie bisher im Bordkasse-Pool.
   */
  tranches?: TrancheOption[];
  /**
   * Darf der eingeloggte User die Anzahlungs-Tranche-Zuordnung ändern?
   * True für Skipper/Admin/Vorstrecker. False für normale Crew — sie sieht
   * das Feld dann gar nicht (vermeidet Verwirrung), bestehende Zuordnung
   * bleibt aber via Hidden-Input erhalten.
   */
  canEditTranche?: boolean;
  /** Wenn gesetzt, Form öffnet im Edit-Mode für eine Ausgabe. */
  expenseInitial?: ExpenseInitial;
  /** Wenn gesetzt, Form öffnet im Edit-Mode für eine Gutschrift. */
  creditInitial?: CreditInitial;
}

export function TransactionForm({
  tripId,
  isSkipper,
  members,
  categories,
  currentPersonId,
  tranches,
  canEditTranche = false,
  tripStart,
  tripEnd,
  expenseInitial,
  creditInitial,
}: TransactionFormProps) {
  const isEdit = !!(expenseInitial || creditInitial);
  const initialType: "expense" | "credit" =
    creditInitial ? "credit" : expenseInitial ? "expense" : "expense";
  const [type, setType] = useState<"expense" | "credit">(initialType);

  return (
    <>
      {/* Sticky-Header bricht aus dem Page-Padding aus (`-mx-4 -mt-6`),
          damit beim Scrollen oben immer der Abbrechen-Pfeil sichtbar bleibt. */}
      <div className="sticky top-0 z-10 -mx-4 -mt-6 mb-4 flex items-center gap-2 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur-sm">
        <Link
          href={`/trips/${tripId}/transactions`}
          className="flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-primary"
          aria-label="Abbrechen"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-xl font-bold text-primary">
          {isEdit ? "Buchung bearbeiten" : "Neue Buchung"}
        </h1>
      </div>

      {/* Type-Toggle gibt's nur im Create-Modus — im Edit-Modus bleibt der Typ fix. */}
      {!isEdit && isSkipper && (
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-md bg-paper-soft p-1">
          {(["expense", "credit"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setType(opt)}
              className={cn(
                "rounded-md py-2 text-sm font-medium transition-colors",
                type === opt ? "bg-paper text-primary shadow-sm" : "text-ink-soft hover:text-ink",
              )}
            >
              {opt === "expense" ? "Ausgabe" : "Gutschrift"}
            </button>
          ))}
        </div>
      )}

      {type === "expense" || (!isSkipper && !creditInitial) ? (
        <ExpenseForm
          tripId={tripId}
          members={members}
          categories={categories}
          currentPersonId={currentPersonId}
          tranches={tranches}
          canEditTranche={canEditTranche}
          tripStart={tripStart}
          tripEnd={tripEnd}
          initial={expenseInitial}
        />
      ) : (
        <CreditForm
          tripId={tripId}
          members={members}
          currentPersonId={currentPersonId}
          tranches={tranches}
          canEditTranche={canEditTranche}
          tripStart={tripStart}
          tripEnd={tripEnd}
          initial={creditInitial}
        />
      )}
    </>
  );
}

/**
 * Wiederverwendbares Tranche-Select für Expense + Credit-Form.
 * Rendert ein Hidden-Input + ein zusammenklappbares `<details>`. Wenn die
 * Buchung schon einer Tranche zugeordnet ist, ist das Detail offen — damit
 * der User das nicht aus Versehen "vergisst" und beim Edit aktiviert.
 */
function TrancheField({
  tranches,
  initialTrancheId,
  canEdit,
}: {
  tranches?: TrancheOption[];
  initialTrancheId?: string | null;
  /**
   * Nur Skipper/Admin/Vorstrecker dürfen die Anzahlungs-Tranche setzen
   * oder ändern. Crew sieht das Feld gar nicht. Die canEditTransaction-
   * Policy in lib/actions/transactions.ts erlaubt Crew sowieso nur
   * eigene Buchungen zu editieren — eine vom Skipper mit tranche_id
   * angelegte Buchung kann die Crew nie aufrufen, daher kein Bedarf
   * für eine Hidden-Input-Preservation.
   */
  canEdit: boolean;
}) {
  const [value, setValue] = useState(initialTrancheId ?? "");
  if (!tranches || tranches.length === 0) return null;
  if (!canEdit) return null;

  return (
    <details open={!!initialTrancheId} className="rounded-md border border-rule bg-paper p-3 text-sm">
      <summary className="cursor-pointer text-ink-soft">
        Anzahlungs-Tranche zuordnen
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
          <option value="">— Keine (Bordkasse-Pool) —</option>
          {tranches.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({formatDeDate(t.due_date)})
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-ink-soft">
        Wenn gesetzt, landet die Buchung im Anzahlungs-Pool statt in der laufenden Bordkasse.
      </p>
    </details>
  );
}

function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function ExpenseForm({
  tripId,
  members,
  categories,
  currentPersonId,
  tranches,
  canEditTranche,
  tripStart,
  tripEnd,
  initial,
}: {
  tripId: string;
  members: Member[];
  categories: Category[];
  currentPersonId?: string;
  tranches?: TrancheOption[];
  canEditTranche: boolean;
  tripStart?: string;
  tripEnd?: string;
  initial?: ExpenseInitial;
}) {
  // Eingeloggten User im "Bezahlt von"-Dropdown nach oben sortieren.
  const paidByOptions = (() => {
    const opts = members.map((m) => ({ id: m.person_id, name: m.display_name }));
    if (!currentPersonId) return opts;
    const me = opts.find((o) => o.id === currentPersonId);
    if (!me) return opts;
    return [me, ...opts.filter((o) => o.id !== currentPersonId)];
  })();
  const router = useRouter();
  const isEdit = !!initial;
  const [state, formAction, pending] = useActionState(
    isEdit ? updateExpense : createExpense,
    idleState,
  );
  const [splitType, setSplitType] = useState<SplitType>(initial?.splitType ?? "equal");
  const [showAdvanced, setShowAdvanced] = useState(!!initial && initial.alcoholAmount > 0);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // Controlled-State für native Inputs, damit React-19's automatischer
  // Form-Reset nach Submit die Eingaben bei Validierungs-Fehler nicht löscht.
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial ? formatAmount(initial.amount) : "");
  const [alcoholAmount, setAlcoholAmount] = useState(
    initial && initial.alcoholAmount > 0 ? formatAmount(initial.alcoholAmount) : "",
  );
  const [tipAmount, setTipAmount] = useState(
    initial && initial.tipAmount > 0 ? formatAmount(initial.tipAmount) : "",
  );
  const [tipDistribution, setTipDistribution] = useState<"proportional" | "equal">(
    initial?.tipDistribution ?? "proportional",
  );
  const [participantIds, setParticipantIds] = useState<Set<string>>(
    () => new Set(initial?.participantIds ?? []),
  );
  const toggleParticipant = (id: string) =>
    setParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Per-Person-Beträge als Map<person_id, Eingabe-String>. String, damit der
  // User "3+17" stehen lassen kann; safeMathEval übersetzt zur Anzeige.
  const [perPersonInputs, setPerPersonInputs] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (initial?.participantAmounts) {
      for (const p of initial.participantAmounts) {
        init[p.personId] = formatAmount(p.amount);
      }
    }
    return init;
  });
  const setPerPerson = (personId: string, value: string) =>
    setPerPersonInputs((prev) => ({ ...prev, [personId]: value }));

  // Pro-Person-Beträge ausgewertet (Mini-Rechner). 0 wenn Eingabe leer/ungültig.
  const perPersonAmounts = useMemo(
    () =>
      members.map((m) => {
        const raw = perPersonInputs[m.person_id] ?? "";
        const val = safeMathEval(raw);
        return {
          personId: m.person_id,
          displayName: m.display_name,
          raw,
          amount: val ?? 0,
          valid: raw === "" || val !== null,
        };
      }),
    [members, perPersonInputs],
  );
  const perPersonSum = perPersonAmounts.reduce((s, p) => s + p.amount, 0);

  // Bei 'per_person' wird der Gesamtbetrag aus den Einzelbeträgen berechnet —
  // das Betrag-Feld zeigt die Summe, ist nicht editierbar.
  const isPerPerson = splitType === "per_person";
  const displayAmount = isPerPerson ? formatAmount(perPersonSum) : amount;

  // Bei Validierungs-Fehler: zum betroffenen Feld scrollen + fokussieren.
  useEffect(() => {
    if (state.status !== "error" || !state.field) return;
    const el = document.getElementById(state.field);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  }, [state]);

  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Fat-Finger-Schutz: ungewöhnlich hoher Betrag (oft eine Null zu viel) →
    // weiche Rückfrage vor dem Speichern. Harte Max-Grenze prüft die Action.
    const total = isPerPerson ? perPersonSum : Number(amount.replace(",", "."));
    if (
      Number.isFinite(total) &&
      total > FAT_FINGER_THRESHOLD &&
      !window.confirm(
        `${formatEuro(total)} ist ungewöhnlich hoch für eine einzelne Buchung. Stimmt der Betrag?`,
      )
    ) {
      e.preventDefault();
      return;
    }
    if (!isEdit && typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "expense",
        formData: obj,
        createdAt: nowMs(),
      })
        .then(() => router.push(`/trips/${tripId}/transactions`))
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    }
  };

  // Mid-Flight-Schutz: Bricht die Verbindung NACH dem Klick aber VOR dem
  // Redirect ab (typisch bei wackeligem Bord-WLAN), rettet dieser Listener die
  // Buchung in die Outbox. Dedup-sicher über den identischen idempotency_key:
  // selbst wenn die Server-Action serverseitig doch noch durchlief, verwirft
  // der Replay-Insert das Duplikat (UNIQUE-Constraint).
  useEffect(() => {
    if (isEdit || !pending) return;
    const onOffline = () => {
      const form = formRef.current;
      if (!form) return;
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "expense",
        formData: formDataToObject(new FormData(form)),
        createdAt: nowMs(),
      }).catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    };
    window.addEventListener("offline", onOffline);
    return () => window.removeEventListener("offline", onOffline);
  }, [isEdit, pending, idempotencyKey, tripId]);

  const errorField = state.status === "error" ? state.field : undefined;
  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const fieldError = (field: string) => fieldErrors[field];
  const isInvalid = (field: string) => !!fieldErrors[field] || errorField === field;

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="split_type" value={splitType} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup label="Datum" htmlFor="date" error={fieldError("date")}>
        <input
          id="date" name="date" type="date" required
          value={date}
          min={tripStart}
          max={tripEnd}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={isInvalid("date") || undefined}
          className={cn(inputCls, isInvalid("date") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description" error={fieldError("description")}>
        <input
          id="description" name="description" type="text" required maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="z. B. Lebensmittel Edeka"
          aria-invalid={isInvalid("description") || undefined}
          className={cn(inputCls, isInvalid("description") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Kategorie" error={fieldError("category_id")}>
        <CategorySelect
          name="category_id"
          categories={categories}
          defaultCategoryId={initial?.categoryId ?? undefined}
          invalid={isInvalid("category_id")}
        />
      </FieldGroup>

      <FieldGroup label="Bezahlt von" error={fieldError("paid_by")}>
        <PersonSelect
          name="paid_by"
          options={paidByOptions}
          // Create-Modus: mit der eingeloggten Person vorbelegt — meist zahlt
          // die erfassende Person selbst (bei Bedarf umstellbar). Edit-Modus
          // behält die gebuchte Person.
          defaultValue={initial?.paidBy ?? currentPersonId ?? ""}
          invalid={isInvalid("paid_by")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount" error={fieldError("amount")} hint={isPerPerson ? "Wird aus den Einzelbeträgen unten berechnet." : undefined}>
        <input
          id="amount" name="amount" type="text" required={!isPerPerson}
          inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?"
          autoComplete="off"
          value={displayAmount}
          onChange={(e) => setAmount(e.target.value)}
          readOnly={isPerPerson}
          placeholder="0,00"
          aria-invalid={isInvalid("amount") || undefined}
          className={cn(
            inputCls,
            isInvalid("amount") && "border-danger ring-2 ring-danger/20",
            isPerPerson && "bg-paper-soft text-ink-soft",
          )}
        />
      </FieldGroup>

      {/* Aufteilung als Tab-Row mit Underline für die aktive Auswahl.
          Die einzelnen Modi werden im ⓘ-Tooltip neben der Überschrift erklärt —
          spart eine Hilfezeile, die das Form sonst pro Tab gerendert hat. */}
      <div>
        <span className="block text-sm font-medium">
          Aufteilung
          <InfoTooltip text={SPLIT_TOOLTIP} label="Aufteilungs-Modi erklärt" />
        </span>
        <div className="mt-2 flex border-b border-rule" role="tablist" aria-label="Aufteilung">
          {(Object.keys(SPLIT_LABEL) as SplitType[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={splitType === s}
              onClick={() => setSplitType(s)}
              className={cn(
                "flex-1 border-b-2 px-1 py-2 text-xs font-medium transition-colors -mb-px",
                splitType === s
                  ? "border-primary text-primary"
                  : "border-transparent text-ink-soft hover:text-ink",
              )}
            >
              {SPLIT_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {splitType === "individual" && (
        <FieldGroup label="Wer ist dabei?" error={fieldError("participant_ids")}>
          <div
            id="participant_ids"
            tabIndex={-1}
            className={cn(
              "flex flex-wrap gap-2 rounded-md border border-rule bg-paper p-3 outline-none",
              isInvalid("participant_ids") && "border-danger ring-2 ring-danger/20",
            )}
          >
            {members.map((m) => {
              const active = participantIds.has(m.person_id);
              return (
                <button
                  key={m.person_id}
                  type="button"
                  onClick={() => toggleParticipant(m.person_id)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-paper"
                      : "border-rule bg-paper text-ink hover:border-primary/50",
                  )}
                >
                  {active && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {m.display_name}
                </button>
              );
            })}
            {/* Hidden inputs für FormData-Submission */}
            {Array.from(participantIds).map((id) => (
              <input key={id} type="hidden" name="participant_ids" value={id} />
            ))}
          </div>
        </FieldGroup>
      )}

      {isPerPerson && (
        <FieldGroup label="Wer zahlt was?" error={fieldError("participant_amounts")} hint={"Pro Person Betrag eintragen. Rechnen geht auch (z. B. „3 + 17“) — auf dem Smartphone die „?123“-Taste der Tastatur für die Operatoren. Leer = nicht beteiligt."}>
          <div
            id="participant_amounts"
            tabIndex={-1}
            className={cn(
              "space-y-2 rounded-md border border-rule bg-paper p-3 outline-none",
              isInvalid("participant_amounts") && "border-danger ring-2 ring-danger/20",
            )}
          >
            {perPersonAmounts.map((p) => {
              const showEval = p.raw && p.valid && /[+\-*/]/.test(p.raw);
              return (
                <div key={p.personId} className="flex items-center gap-3">
                  <label
                    htmlFor={`pp-${p.personId}`}
                    className="min-w-0 flex-1 truncate text-sm"
                  >
                    {p.displayName}
                  </label>
                  <div className="flex w-40 flex-col items-end gap-0.5">
                    <div className="flex w-full items-center gap-2">
                      {/* inputMode="text" statt "decimal", damit Mobile-Tastaturen
                          die Symbol-Taste ("123" / "?123") für Operatoren erlauben
                          — sonst ist man auf reines Zahlen-Pad festgenagelt und
                          kann keine Rechenausdrücke wie "3+4" eintragen. */}
                      <input
                        id={`pp-${p.personId}`}
                        type="text"
                        inputMode="text"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={p.raw}
                        onChange={(e) => setPerPerson(p.personId, e.target.value)}
                        placeholder="–"
                        aria-describedby={showEval ? `pp-eval-${p.personId}` : undefined}
                        className={cn(
                          "h-10 w-full rounded-md border bg-paper px-2 text-right text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
                          p.valid ? "border-rule" : "border-danger ring-2 ring-danger/20",
                        )}
                      />
                      <span className="w-4 shrink-0 text-sm text-ink-soft">€</span>
                    </div>
                    {/* Ergebnis des Mini-Rechners sichtbar machen (z. B. „= 20,00 €"),
                        damit die Person den ausgewerteten Betrag vor dem Speichern sieht. */}
                    {showEval && (
                      <span
                        id={`pp-eval-${p.personId}`}
                        className="pr-6 text-xs text-ink-soft"
                        aria-live="polite"
                      >
                        = {formatAmount(p.amount)} €
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between border-t border-rule pt-2 text-sm font-medium">
              <span>Summe</span>
              <span className="text-primary">{formatEuro(perPersonSum)}</span>
            </div>
            {/* JSON-Bundle für FormData. Nur Einträge mit amount > 0. */}
            <input
              type="hidden"
              name="participant_amounts"
              value={JSON.stringify(
                perPersonAmounts
                  .filter((p) => p.amount > 0)
                  .map((p) => ({ person_id: p.personId, amount: p.amount })),
              )}
            />
          </div>
        </FieldGroup>
      )}

      {/* Trinkgeld ist semantisch nur bei "Pro Person" sinnvoll (Restaurant-
          Szenario); für andere Aufteilungen wäre es eine versteckte Falle. */}
      {isPerPerson && (
        <>
          <FieldGroup label="Trinkgeld (€)" htmlFor="tip_amount" error={fieldError("tip_amount")}>
            <input
              id="tip_amount" name="tip_amount" type="text"
              inputMode="decimal" pattern="([0-9]+([,.][0-9]{1,2})?)?"
              autoComplete="off"
              placeholder="0,00"
              value={tipAmount}
              onChange={(e) => setTipAmount(e.target.value)}
              aria-invalid={isInvalid("tip_amount") || undefined}
              className={cn(inputCls, isInvalid("tip_amount") && "border-danger ring-2 ring-danger/20")}
            />
          </FieldGroup>

          {/* Hidden-Input für FormData — Toggle ist Client-State. */}
          <input type="hidden" name="tip_distribution" value={tipDistribution} />

          {/* Verteilungs-Toggle nur sichtbar wenn überhaupt Trinkgeld gesetzt ist. */}
          {(() => {
            const tip = parseFloat(tipAmount.replace(",", ".")) || 0;
            if (tip <= 0) return null;
            return (
              <div>
                <span className="block text-sm font-medium">Trinkgeld verteilen</span>
                <div className="mt-2 flex border-b border-rule" role="tablist" aria-label="Trinkgeld-Verteilung">
                  {(["proportional", "equal"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={tipDistribution === mode}
                      onClick={() => setTipDistribution(mode)}
                      className={cn(
                        "flex-1 border-b-2 px-1 py-2 text-xs font-medium transition-colors -mb-px",
                        tipDistribution === mode
                          ? "border-primary text-primary"
                          : "border-transparent text-ink-soft hover:text-ink",
                      )}
                    >
                      {mode === "proportional" ? "Proportional" : "Pro Person gleich"}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink-soft">
                  {tipDistribution === "proportional"
                    ? "Anteilig zum Bestellbetrag — wer mehr bestellt, zahlt mehr Trinkgeld."
                    : `Jeder Beteiligte zahlt gleich viel Trinkgeld.`}
                </p>
              </div>
            );
          })()}
        </>
      )}

      {!isPerPerson && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-sm text-ink-soft hover:text-primary"
          >
            {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            Erweitert (Alkohol-Anteil)
          </button>
          {showAdvanced && (
            <FieldGroup label="Alkohol-Anteil (€)" htmlFor="alcohol_amount" error={fieldError("alcohol_amount")} hint="Wird auf alle verteilt, die Alkohol mittrinken; Rest nach Aufteilung.">
              <input
                id="alcohol_amount" name="alcohol_amount" type="text"
                inputMode="decimal" pattern="([0-9]+([,.][0-9]{1,2})?)?"
                autoComplete="off"
                placeholder="0,00"
                value={alcoholAmount}
                onChange={(e) => setAlcoholAmount(e.target.value)}
                aria-invalid={isInvalid("alcohol_amount") || undefined}
                className={cn(inputCls, isInvalid("alcohol_amount") && "border-danger ring-2 ring-danger/20")}
              />
            </FieldGroup>
          )}
        </>
      )}

      <TrancheField tranches={tranches} initialTrancheId={initial?.trancheId ?? null} canEdit={canEditTranche} />

      {/* Sammel-Fehler nur für allgemeine/DB-Fehler — Feld-Fehler stehen schon
          direkt unter dem jeweiligen Feld. */}
      {state.status === "error" &&
        Object.keys(state.fieldErrors ?? {}).length === 0 && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : isEdit ? "Änderungen speichern" : "Ausgabe speichern"}
      </button>
    </form>
  );
}

function CreditForm({
  tripId,
  members,
  currentPersonId,
  tranches,
  canEditTranche,
  tripStart,
  tripEnd,
  initial,
}: {
  tripId: string;
  members: Member[];
  currentPersonId?: string;
  tranches?: TrancheOption[];
  canEditTranche: boolean;
  tripStart?: string;
  tripEnd?: string;
  initial?: CreditInitial;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [state, formAction, pending] = useActionState(
    isEdit ? updateCredit : createCredit,
    idleState,
  );
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // Controlled-State, damit React-19's automatischer Form-Reset die Eingaben
  // bei Validierungs-Fehlern nicht löscht (siehe ExpenseForm oben).
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial ? formatAmount(initial.amount) : "");

  const initialCreditTo: string = initial
    ? initial.creditTo == null
      ? "ALL"
      : initial.creditTo
    : "";

  useEffect(() => {
    if (state.status !== "error" || !state.field) return;
    const el = document.getElementById(state.field);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  }, [state]);

  const errorField = state.status === "error" ? state.field : undefined;
  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const fieldError = (field: string) => fieldErrors[field];
  const isInvalid = (field: string) => !!fieldErrors[field] || errorField === field;

  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Fat-Finger-Schutz wie bei der Ausgabe.
    const total = Number(amount.replace(",", "."));
    if (
      Number.isFinite(total) &&
      total > FAT_FINGER_THRESHOLD &&
      !window.confirm(
        `${formatEuro(total)} ist ungewöhnlich hoch für eine einzelne Gutschrift. Stimmt der Betrag?`,
      )
    ) {
      e.preventDefault();
      return;
    }
    if (!isEdit && typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "credit",
        formData: obj,
        createdAt: nowMs(),
      })
        .then(() => router.push(`/trips/${tripId}/transactions`))
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    }
  };

  // Mid-Flight-Schutz (siehe ExpenseForm): geht die Verbindung während eines
  // laufenden Submits verloren, in die Outbox retten. Dedup über idempotency_key.
  useEffect(() => {
    if (isEdit || !pending) return;
    const onOffline = () => {
      const form = formRef.current;
      if (!form) return;
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "credit",
        formData: formDataToObject(new FormData(form)),
        createdAt: nowMs(),
      }).catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    };
    window.addEventListener("offline", onOffline);
    return () => window.removeEventListener("offline", onOffline);
  }, [isEdit, pending, idempotencyKey, tripId]);

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup label="Datum" htmlFor="date" error={fieldError("date")}>
        <input id="date" name="date" type="date" required
          value={date}
          min={tripStart}
          max={tripEnd}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={isInvalid("date") || undefined}
          className={cn(inputCls, isInvalid("date") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description" error={fieldError("description")} hint="Optional. Leer → 'Gutschrift'.">
        <input
          id="description" name="description" type="text" maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="z. B. Yacht-Anteil-Rückzahlung"
          aria-invalid={isInvalid("description") || undefined}
          className={cn(inputCls, isInvalid("description") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount" error={fieldError("amount")}>
        <input
          id="amount" name="amount" type="text" required
          inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0,00"
          aria-invalid={isInvalid("amount") || undefined}
          className={cn(inputCls, isInvalid("amount") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Zahlt (Von)" error={fieldError("credit_from")}>
        <PersonSelect
          name="credit_from"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          defaultValue={initial?.creditFrom ?? ""}
          invalid={isInvalid("credit_from")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <FieldGroup label="Empfängt (An)" error={fieldError("credit_to")}>
        <PersonSelect
          name="credit_to"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          extraOption={{ value: "ALL", label: "Alle (Aufteilung an gesamte Crew)" }}
          defaultValue={initialCreditTo}
          invalid={isInvalid("credit_to")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <TrancheField tranches={tranches} initialTrancheId={initial?.trancheId ?? null} canEdit={canEditTranche} />

      {/* Sammel-Fehler nur für allgemeine/DB-Fehler — Feld-Fehler stehen schon
          direkt unter dem jeweiligen Feld. */}
      {state.status === "error" &&
        Object.keys(state.fieldErrors ?? {}).length === 0 && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : isEdit ? "Änderungen speichern" : "Gutschrift speichern"}
      </button>
    </form>
  );
}

const inputCls =
  "mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

function FieldGroup({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** Feld-spezifische Fehlermeldung — wird direkt unter dem Feld gezeigt. */
  error?: string;
  children: React.ReactNode;
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
