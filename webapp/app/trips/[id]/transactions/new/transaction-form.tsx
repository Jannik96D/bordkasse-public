"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronDown, ChevronUp, Check } from "lucide-react";
import {
  createExpense,
  createCredit,
  updateExpense,
  updateCredit,
} from "@/lib/actions/transactions";
import { todayIso, cn, daysBetween } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
import { InfoTooltip } from "@/components/info-tooltip";
import { PersonSelect } from "@/components/person-select";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { safeMathEval } from "@/lib/utils/math-eval";
import { calculateShares } from "@/lib/calc/shares";
import {
  computeTrancheAutofill,
  type TrancheAutofillState,
} from "@/lib/prepayments/tranche-autofill";
import type { Member as CalcMember, Transaction as CalcTransaction } from "@/lib/calc/types";
import {
  type Member,
  type Category,
  type SplitType,
  type TrancheOption,
  type ExpenseInitial,
  type CreditInitial,
  SPLIT_KEYS,
  splitLabel,
  splitTooltip,
  inputCls,
  formatAmount,
  FieldGroup,
  TrancheField,
  useBookingSubmit,
  SharePreview,
  PerPersonAmounts,
} from "./transaction-form-parts";

// Öffentliche Typen bleiben über diese Datei importierbar (draft-editor, edit-page).
export type { ExpenseInitial, CreditInitial, TrancheOption } from "./transaction-form-parts";

interface TransactionFormProps {
  tripId: string;
  isSkipper: boolean;
  members: Member[];
  categories: Category[];
  /** Törnstart/-Ende (ISO) — begrenzt das Datums-Feld (min/max). */
  tripStart?: string;
  tripEnd?: string;
  /** person_id des eingeloggten Users — im "Bezahlt von"-Dropdown nach oben sortiert. */
  currentPersonId?: string;
  /** Verfügbare Anzahlungstranchen — wenn ≥ 1, blendet das Zuordnungs-Feld ein. */
  tranches?: TrancheOption[];
  /** Darf der User die Tranche-Zuordnung ändern? (Skipper/Admin/Vorstrecker) */
  canEditTranche?: boolean;
  /** Wenn gesetzt, Edit-Mode für eine Ausgabe. */
  expenseInitial?: ExpenseInitial;
  /** Wenn gesetzt, Edit-Mode für eine Gutschrift. */
  creditInitial?: CreditInitial;
  /**
   * Wenn gesetzt, bearbeitet das Form einen noch nicht gesyncten Outbox-Entwurf
   * (= `id` des OutboxItem). Submit schreibt mit GLEICHER id zurück in die Outbox.
   */
  draftId?: string;
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
  draftId,
}: TransactionFormProps) {
  const isEdit = !!(expenseInitial || creditInitial);
  const initialType: "expense" | "credit" = creditInitial ? "credit" : "expense";
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
          draftId={draftId}
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
          draftId={draftId}
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
  tranches,
  canEditTranche,
  tripStart,
  tripEnd,
  initial,
  draftId,
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
  draftId?: string;
}) {
  const vocab = useTripVocab();
  const SPLIT_LABEL = splitLabel(vocab);
  // Eingeloggten User im "Bezahlt von"-Dropdown nach oben sortieren.
  const paidByOptions = (() => {
    const opts = members.map((m) => ({ id: m.person_id, name: m.display_name }));
    if (!currentPersonId) return opts;
    const me = opts.find((o) => o.id === currentPersonId);
    if (!me) return opts;
    return [me, ...opts.filter((o) => o.id !== currentPersonId)];
  })();
  const isDraft = !!draftId;
  const isEdit = !!initial && !isDraft;
  const [splitType, setSplitType] = useState<SplitType>(initial?.splitType ?? "equal");
  const [showAdvanced, setShowAdvanced] = useState(!!initial && initial.alcoholAmount > 0);

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

  // ── Vorbelegung aus der gewählten Anzahlungstranche ─────────────────────
  // Wählt der Skipper/Vorstrecker eine Tranche, füllt das Formular Betrag
  // (= Tranchen-Betrag) und Beschreibung (= Tranchen-Name) vor — der typische
  // Fall „Charter-Überweisung an den Vercharterer erfassen". Datum bleibt wie
  // sonst auf heute. Wir merken uns die zuletzt auto-gefüllten Werte, damit ein
  // Tranchen-Wechsel sie aktualisieren darf, manuell Eingegebenes aber in Ruhe
  // bleibt (und beim Zurücksetzen auf „Keine" nur Auto-Werte wieder geleert
  // werden).
  const trancheAutofillRef = useRef<TrancheAutofillState | null>(null);
  const handleTrancheSelect = (tranche: TrancheOption | null) => {
    const result = computeTrancheAutofill({
      tranche,
      current: { amount, description },
      previous: trancheAutofillRef.current,
      formatAmount,
    });
    setAmount(result.amount);
    setDescription(result.description);
    trancheAutofillRef.current = result.autofill;
  };

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

  // ── Livevorschau der Aufteilung ────────────────────────────────────────
  // Spiegelt mit der exakt gleichen Logik wie der Server (lib/calc/shares.ts)
  // pro Person den Anteil, damit der User VOR dem Speichern sieht, wer wie viel zahlt.
  const previewShares = useMemo(() => {
    const baseAmount = isPerPerson ? perPersonSum : safeMathEval(amount) ?? 0;
    const alc = !isPerPerson ? safeMathEval(alcoholAmount) ?? 0 : 0;
    const tip = isPerPerson ? safeMathEval(tipAmount) ?? 0 : 0;
    if (baseAmount <= 0) return null;

    const calcMembers: CalcMember[] = members.map((m) => {
      const effectiveFrom = m.on_board_from ?? tripStart ?? date;
      const effectiveTo = m.on_board_to ?? tripEnd ?? date;
      return {
        personId: m.person_id,
        displayName: m.display_name,
        isAlcoholic: m.is_alcoholic_effective ?? false,
        effectiveFrom,
        effectiveTo,
        days: daysBetween(effectiveFrom, effectiveTo),
      };
    });

    const tx: CalcTransaction = {
      id: "preview",
      type: "expense",
      date,
      amount: baseAmount,
      alcoholAmount: alc,
      tipAmount: tip,
      tipDistribution,
      splitType,
      participants: Array.from(participantIds),
      participantAmounts: perPersonAmounts
        .filter((p) => p.amount > 0)
        .map((p) => ({ personId: p.personId, amount: p.amount })),
    };

    const shareByPerson = new Map(
      calculateShares(tx, calcMembers).map((s) => [s.personId, s.share]),
    );
    const rows = members
      .map((m) => ({ name: m.display_name, share: shareByPerson.get(m.person_id) ?? 0 }))
      .filter((r) => r.share > 0);
    const sum = rows.reduce((s, r) => s + r.share, 0);
    return { rows, sum };
  }, [
    members,
    isPerPerson,
    perPersonSum,
    amount,
    alcoholAmount,
    tipAmount,
    tipDistribution,
    splitType,
    participantIds,
    perPersonAmounts,
    date,
    tripStart,
    tripEnd,
  ]);

  const { state, formAction, pending, formRef, handleSubmit, fieldError, isInvalid, idempotencyKey } =
    useBookingSubmit({
      tripId,
      kind: "expense",
      isEdit,
      isDraft,
      draftId,
      createAction: createExpense,
      updateAction: updateExpense,
      getTotal: () => (isPerPerson ? perPersonSum : Number(amount.replace(",", "."))),
      fatFingerNoun: "Buchung",
    });

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="split_type" value={splitType} />
      {/* Draft behält seinen idempotency_key (= draftId); frischer Create nutzt den Zufalls-Key. */}
      {!isEdit && <input type="hidden" name="idempotency_key" value={isDraft ? draftId : idempotencyKey} />}
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

      {/* Aufteilung als Tab-Row; die Modi erklärt der ⓘ-Tooltip neben der Überschrift. */}
      <div>
        <span className="block text-sm font-medium">
          Aufteilung
          <InfoTooltip text={splitTooltip(vocab)} label="Aufteilungs-Modi erklärt" />
        </span>
        <div className="mt-2 flex border-b border-rule" role="tablist" aria-label="Aufteilung">
          {SPLIT_KEYS.map((s) => (
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
        <PerPersonAmounts
          rows={perPersonAmounts}
          sum={perPersonSum}
          onChange={setPerPerson}
          error={fieldError("participant_amounts")}
          invalid={isInvalid("participant_amounts")}
        />
      )}

      {/* Trinkgeld ist semantisch nur bei "Pro Person" sinnvoll (Restaurant-Szenario). */}
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
                    ? "Anteilig zum Bestellbetrag: Wer mehr bestellt, zahlt mehr Trinkgeld."
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
            Erweitert (Alkoholanteil)
          </button>
          {showAdvanced && (
            <FieldGroup label="Alkoholanteil (€)" htmlFor="alcohol_amount" error={fieldError("alcohol_amount")} hint="Wird auf alle verteilt, die Alkohol mittrinken; Rest nach Aufteilung.">
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

      {/* Livevorschau: wer zahlt wie viel — eingeklappt per Default. */}
      <SharePreview preview={previewShares} />

      <TrancheField
        tranches={tranches}
        initialTrancheId={initial?.trancheId ?? null}
        canEdit={canEditTranche}
        onSelect={handleTrancheSelect}
      />

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
        {pending
          ? "Speichere …"
          : isDraft
            ? "Entwurf speichern"
            : isEdit
              ? "Änderungen speichern"
              : "Ausgabe speichern"}
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
  draftId,
}: {
  tripId: string;
  members: Member[];
  currentPersonId?: string;
  tranches?: TrancheOption[];
  canEditTranche: boolean;
  tripStart?: string;
  tripEnd?: string;
  initial?: CreditInitial;
  draftId?: string;
}) {
  const vocab = useTripVocab();
  const isDraft = !!draftId;
  const isEdit = !!initial && !isDraft;

  // Controlled-State, damit React-19's Form-Reset Eingaben bei Fehlern nicht löscht.
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial ? formatAmount(initial.amount) : "");

  const initialCreditTo: string = initial
    ? initial.creditTo == null
      ? "ALL"
      : initial.creditTo
    : "";

  const { state, formAction, pending, formRef, handleSubmit, fieldError, isInvalid, idempotencyKey } =
    useBookingSubmit({
      tripId,
      kind: "credit",
      isEdit,
      isDraft,
      draftId,
      createAction: createCredit,
      updateAction: updateCredit,
      getTotal: () => Number(amount.replace(",", ".")),
      fatFingerNoun: "Gutschrift",
    });

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={isDraft ? draftId : idempotencyKey} />}
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
          placeholder="z. B. Yachtanteil-Rückzahlung"
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

      <FieldGroup
        label={
          <>
            Empfängt (An)
            <InfoTooltip
              label="Was bedeutet „An Alle“?"
              text={`„Alle“ verteilt den Betrag gleichmäßig auf die gesamte ${vocab.crew} außer die zahlende Person. Sonst geht die Gutschrift nur an die eine gewählte Person.`}
            />
          </>
        }
        error={fieldError("credit_to")}
      >
        <PersonSelect
          name="credit_to"
          options={members.map((m) => ({ id: m.person_id, name: m.display_name }))}
          extraOption={{ value: "ALL", label: `Alle (Aufteilung an gesamte ${vocab.crew})` }}
          defaultValue={initialCreditTo}
          invalid={isInvalid("credit_to")}
          currentUserId={currentPersonId}
        />
      </FieldGroup>

      <TrancheField tranches={tranches} initialTrancheId={initial?.trancheId ?? null} canEdit={canEditTranche} />

      {/* Sammel-Fehler nur für allgemeine/DB-Fehler. */}
      {state.status === "error" &&
        Object.keys(state.fieldErrors ?? {}).length === 0 && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending
          ? "Speichere …"
          : isDraft
            ? "Entwurf speichern"
            : isEdit
              ? "Änderungen speichern"
              : "Gutschrift speichern"}
      </button>
    </form>
  );
}
