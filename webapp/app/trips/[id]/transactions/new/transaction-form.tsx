"use client";

import { useActionState, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronDown, ChevronUp } from "lucide-react";
import {
  createExpense,
  createCredit,
  updateExpense,
  updateCredit,
  type TxState,
} from "@/lib/actions/transactions";
import { enqueue } from "@/lib/offline/outbox";
import { todayIso, cn } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
import { PersonSelect } from "@/components/person-select";

type Member = { person_id: string; display_name: string };
type Category = { id: string; name: string; icon: string | null };
type SplitType = "equal" | "on_board" | "time_proportional" | "individual";

const SPLIT_LABEL: Record<SplitType, string> = {
  equal: "Gleichmäßig",
  on_board: "An Bord",
  time_proportional: "Zeitanteilig",
  individual: "Individuell",
};

const SPLIT_HINT: Record<SplitType, string> = {
  equal: "Alle zahlen gleich, unabhängig von Anwesenheit.",
  on_board: "Nur Personen, die am Datum der Ausgabe an Bord waren.",
  time_proportional: "Proportional zu Bord-Tagen pro Person.",
  individual: "Nur explizit markierte Personen.",
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
  splitType: SplitType;
  participantIds: string[];
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
          initial={expenseInitial}
        />
      ) : (
        <CreditForm tripId={tripId} members={members} initial={creditInitial} />
      )}
    </>
  );
}

function ExpenseForm({
  tripId,
  members,
  categories,
  initial,
}: {
  tripId: string;
  members: Member[];
  categories: Category[];
  initial?: ExpenseInitial;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [state, formAction, pending] = useActionState(
    isEdit ? updateExpense : createExpense,
    idleState,
  );
  const [splitType, setSplitType] = useState<SplitType>(initial?.splitType ?? "equal");
  const [showAdvanced, setShowAdvanced] = useState(!!initial && initial.alcoholAmount > 0);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

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

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="split_type" value={splitType} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup label="Datum" htmlFor="date">
        <input
          id="date" name="date" type="date" required
          defaultValue={initial?.date ?? todayIso()}
          className={inputCls}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description">
        <input
          id="description" name="description" type="text" required maxLength={120}
          defaultValue={initial?.description ?? ""}
          placeholder="z. B. Lebensmittel Edeka"
          className={inputCls}
        />
      </FieldGroup>

      <FieldGroup label="Kategorie">
        <CategorySelect
          name="category_id"
          categories={categories}
          defaultCategoryId={initial?.categoryId ?? undefined}
        />
      </FieldGroup>

      <FieldGroup label="Bezahlt von">
        <PersonSelect
          name="paid_by"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          defaultValue={initial?.paidBy ?? ""}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount">
        <input
          id="amount" name="amount" type="text" required
          inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?"
          autoComplete="off"
          defaultValue={initial ? formatAmount(initial.amount) : ""}
          placeholder="0,00"
          className={inputCls}
        />
      </FieldGroup>

      <div>
        <label className="block text-sm font-medium">Aufteilung</label>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-paper-soft p-1 sm:grid-cols-4">
          {(Object.keys(SPLIT_LABEL) as SplitType[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSplitType(s)}
              className={cn(
                "rounded-md py-2 text-xs font-medium transition-colors",
                splitType === s ? "bg-paper text-primary shadow-sm" : "text-ink-soft hover:text-ink",
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
          <ul className="space-y-1 rounded-md border border-rule bg-paper p-3">
            {members.map((m) => (
              <li key={m.person_id}>
                <label className="flex items-center gap-3 py-1">
                  <input
                    type="checkbox"
                    name="participant_ids"
                    value={m.person_id}
                    defaultChecked={initial?.participantIds.includes(m.person_id) ?? false}
                    className="h-5 w-5 rounded border-rule"
                  />
                  <span>{m.display_name}</span>
                </label>
              </li>
            ))}
          </ul>
        </FieldGroup>
      )}

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
            defaultValue={initial && initial.alcoholAmount > 0 ? formatAmount(initial.alcoholAmount) : ""}
            className={inputCls}
          />
        </FieldGroup>
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
  initial,
}: {
  tripId: string;
  members: Member[];
  initial?: CreditInitial;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [state, formAction, pending] = useActionState(
    isEdit ? updateCredit : createCredit,
    idleState,
  );
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const initialCreditTo: string = initial
    ? initial.creditTo == null
      ? "ALL"
      : initial.creditTo
    : "";

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
          defaultValue={initial?.date ?? todayIso()}
          className={inputCls}
        />
      </FieldGroup>

      <FieldGroup label="Beschreibung" htmlFor="description" hint="Optional. Leer → 'Gutschrift'.">
        <input
          id="description" name="description" type="text" maxLength={120}
          defaultValue={initial?.description ?? ""}
          placeholder="z. B. Yacht-Anteil-Rückzahlung"
          className={inputCls}
        />
      </FieldGroup>

      <FieldGroup label="Betrag (€)" htmlFor="amount">
        <input
          id="amount" name="amount" type="text" required
          inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?"
          autoComplete="off"
          defaultValue={initial ? formatAmount(initial.amount) : ""}
          placeholder="0,00"
          className={inputCls}
        />
      </FieldGroup>

      <FieldGroup label="Zahlt (Von)">
        <PersonSelect
          name="credit_from"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          defaultValue={initial?.creditFrom ?? ""}
        />
      </FieldGroup>

      <FieldGroup label="Empfängt (An)">
        <PersonSelect
          name="credit_to"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          extraOption={{ value: "ALL", label: "Alle (Aufteilung an gesamte Crew)" }}
          defaultValue={initialCreditTo}
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
