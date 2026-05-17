"use client";

import { useActionState, useEffect, useMemo, useState, type FormEvent } from "react";
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
import { todayIso, cn, formatEuro } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
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

const SPLIT_HINT: Record<SplitType, string> = {
  equal: "Alle zahlen gleich, unabhängig von Anwesenheit.",
  on_board: "Nur Personen, die am Datum der Ausgabe an Bord waren.",
  time_proportional: "Proportional zu Bord-Tagen pro Person.",
  individual: "Nur explizit markierte Personen.",
  per_person: "Jede Person zahlt einen eigenen Betrag (z. B. Restaurant).",
};

const idleState: TxState = { status: "idle" };

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
  splitType: SplitType;
  participantIds: string[];
  participantAmounts: Array<{ personId: string; amount: number }>;
};

export type CreditInitial = {
  transactionId: string;
  date: string;
  description: string;
  amount: number;
  creditFrom: string;
  /** null = "Alle" */
  creditTo: string | null;
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

interface TransactionFormProps {
  tripId: string;
  isSkipper: boolean;
  members: Member[];
  categories: Category[];
  /** person_id des eingeloggten Users — wird im "Bezahlt von"-Dropdown nach oben sortiert. */
  currentPersonId?: string;
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
  expenseInitial,
  creditInitial,
}: TransactionFormProps) {
  const isEdit = !!(expenseInitial || creditInitial);
  const initialType: "expense" | "credit" =
    creditInitial ? "credit" : expenseInitial ? "expense" : "expense";
  const [type, setType] = useState<"expense" | "credit">(initialType);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
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
          initial={expenseInitial}
        />
      ) : (
        <CreditForm
          tripId={tripId}
          members={members}
          currentPersonId={currentPersonId}
          initial={creditInitial}
        />
      )}
    </>
  );
}

function ExpenseForm({
  tripId,
  members,
  categories,
  currentPersonId,
  initial,
}: {
  tripId: string;
  members: Member[];
  categories: Category[];
  currentPersonId?: string;
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

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!isEdit && typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "expense",
        formData: obj,
        createdAt: Date.now(),
      })
        .then(() => router.push(`/trips/${tripId}/transactions`))
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    }
  };

  const errorField = state.status === "error" ? state.field : undefined;
  const isInvalid = (field: string) => errorField === field;

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="split_type" value={splitType} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup label="Datum" htmlFor="date">
        <input
          id="date" name="date" type="date" required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={isInvalid("date") || undefined}
          className={cn(inputCls, isInvalid("date") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description">
        <input
          id="description" name="description" type="text" required maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="z. B. Lebensmittel Edeka"
          aria-invalid={isInvalid("description") || undefined}
          className={cn(inputCls, isInvalid("description") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Kategorie">
        <CategorySelect
          name="category_id"
          categories={categories}
          defaultCategoryId={initial?.categoryId ?? undefined}
          invalid={isInvalid("category_id")}
        />
      </FieldGroup>

      <FieldGroup label="Bezahlt von">
        <PersonSelect
          name="paid_by"
          options={paidByOptions}
          defaultValue={initial?.paidBy ?? ""}
          invalid={isInvalid("paid_by")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount" hint={isPerPerson ? "Wird aus den Einzelbeträgen unten berechnet." : undefined}>
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

      {/* Aufteilung als Tab-Row mit Underline für die aktive Auswahl. */}
      <div>
        <span className="block text-sm font-medium">Aufteilung</span>
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
        <p className="mt-2 text-xs text-ink-soft">{SPLIT_HINT[splitType]}</p>
      </div>

      {splitType === "individual" && (
        <FieldGroup label="Wer ist dabei?">
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
        <FieldGroup label="Wer zahlt was?" hint={"Pro Person Betrag eintragen. Rechnen geht auch (z. B. „3 + 17“) — auf dem Smartphone die „?123“-Taste der Tastatur für die Operatoren. Leer = nicht beteiligt."}>
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
                  <div className="flex w-40 items-center gap-2">
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
                      className={cn(
                        "h-10 w-full rounded-md border bg-paper px-2 text-right text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
                        p.valid ? "border-rule" : "border-danger ring-2 ring-danger/20",
                      )}
                    />
                    <span className="w-4 shrink-0 text-sm text-ink-soft">€</span>
                  </div>
                  {showEval && (
                    <span className="absolute hidden">{formatAmount(p.amount)}</span>
                  )}
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
        <FieldGroup label="Trinkgeld (€)" htmlFor="tip_amount" hint="Wird proportional auf die Beteiligten verteilt.">
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
            <FieldGroup label="Alkohol-Anteil (€)" htmlFor="alcohol_amount" hint="Wird unter Trinkern verteilt; Rest nach Aufteilung.">
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

      {state.status === "error" && (
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
  initial,
}: {
  tripId: string;
  members: Member[];
  currentPersonId?: string;
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
  const isInvalid = (field: string) => errorField === field;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!isEdit && typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      const obj = formDataToObject(new FormData(e.currentTarget));
      enqueue({
        id: idempotencyKey,
        tripId,
        kind: "credit",
        formData: obj,
        createdAt: Date.now(),
      })
        .then(() => router.push(`/trips/${tripId}/transactions`))
        .catch((err) => console.error("Outbox-Schreiben fehlgeschlagen:", err));
    }
  };

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup label="Datum" htmlFor="date">
        <input id="date" name="date" type="date" required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={isInvalid("date") || undefined}
          className={cn(inputCls, isInvalid("date") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description" hint="Optional. Leer → 'Gutschrift'.">
        <input
          id="description" name="description" type="text" maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="z. B. Yacht-Anteil-Rückzahlung"
          aria-invalid={isInvalid("description") || undefined}
          className={cn(inputCls, isInvalid("description") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount">
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

      <FieldGroup label="Zahlt (Von)">
        <PersonSelect
          name="credit_from"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          defaultValue={initial?.creditFrom ?? ""}
          invalid={isInvalid("credit_from")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <FieldGroup label="Empfängt (An)">
        <PersonSelect
          name="credit_to"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          extraOption={{ value: "ALL", label: "Alle (Aufteilung an gesamte Crew)" }}
          defaultValue={initialCreditTo}
          invalid={isInvalid("credit_to")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      {state.status === "error" && (
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
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}
