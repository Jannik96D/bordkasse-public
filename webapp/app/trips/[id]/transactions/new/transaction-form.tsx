"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronDown, ChevronUp, Check } from "lucide-react";
import {
  createExpense,
  createCredit,
  updateExpense,
  updateCredit,
} from "@/lib/actions/transactions";
import { todayIso, cn, daysBetween, round2 } from "@/lib/utils";
import { foreignToEur } from "@/lib/rates/convert";
import { withBookingCurrency } from "@/lib/rates/options";
import { cacheRates, getCachedRate } from "@/lib/offline/rate-cache";
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
  type CurrencyChoice,
  SPLIT_KEYS,
  splitLabel,
  splitTooltip,
  inputCls,
  formatAmount,
  formatRate,
  parseRate,
  FieldGroup,
  TrancheField,
  useBookingSubmit,
  SharePreview,
  PerPersonAmounts,
  CurrencyField,
} from "./transaction-form-parts";

// Öffentliche Typen bleiben über diese Datei importierbar (draft-editor, edit-page).
export type { ExpenseInitial, CreditInitial, TrancheOption } from "./transaction-form-parts";

/**
 * onBlur-Handler für Betragsfelder: wertet einen Rechen-Ausdruck aus (z. B.
 * „47,30 − 6,00" → „41,30") und schreibt das formatierte Ergebnis zurück.
 * Genau wie bei Pro Person (safeMathEval) — praktisch, um Privatkäufe
 * direkt vom Bon rauszurechnen, ohne Taschenrechner. Leere oder ungültige
 * Eingaben bleiben unangetastet; Vorschau + Server-Schema fangen Ungültiges ab.
 */
function evalAmountField(raw: string, setter: (v: string) => void): void {
  const result = safeMathEval(raw);
  if (result !== null) setter(formatAmount(result));
}

/**
 * Effektiver Kurs für die EUR-Anzeigen (Vorschau, Fat-Finger) — spiegelt die
 * serverseitige Berechnung (lib/rates/resolve.ts:effectiveRate): der geschätzte Kurs, ODER
 * wenn ein Bankbetrag eingetragen wurde, Bankbetrag ÷ Fremdbetrag. Divisor ist
 * der volle Fremdbetrag der Kartenzahlung (`bankForeignInput`), falls angegeben
 * — so bleibt der Kurs korrekt, wenn im Betrag etwas rausgerechnet wurde (z. B.
 * Privatkauf); sonst der Buchungsbetrag selbst. `null`, wenn kein Kurs vorliegt.
 */
function computeEffRate(
  isForeign: boolean,
  rateNum: number | null,
  bankInput: string,
  bankForeignInput: string,
  foreignTotal: number,
): number | null {
  if (!isForeign) return null;
  const bankEur = safeMathEval(bankInput);
  if (bankEur != null && bankEur > 0) {
    const bankForeign = safeMathEval(bankForeignInput);
    const divisor = bankForeign != null && bankForeign > 0 ? bankForeign : foreignTotal;
    if (divisor > 0) return bankEur / divisor;
  }
  return rateNum;
}

/**
 * Geteilter Währungs-State für Ausgabe- und Gutschrift-Formular (Migration
 * 0041). Verwaltet die gewählte Währung, den (editierbaren) Kurs und die
 * Kursquelle. Wechselt der User die Währung, wird der Kurs aus den vom Server
 * mitgegebenen currencyOptions vorbefüllt (Live-Tageskurs bzw. offline der Kurs
 * der letzten Buchung); tippt er selbst am Kurs, gilt die Quelle als „manuell".
 */
function useCurrencyState(
  tripId: string,
  options: CurrencyChoice[],
  initial?: {
    originalCurrency?: string | null;
    exchangeRate?: number | null;
    rateSource?: "live" | "manual" | "bank" | null;
    bankAmount?: number | null;
    bankForeignAmount?: number | null;
  },
) {
  const [currency, setCurrency] = useState<string>(initial?.originalCurrency ?? "EUR");
  const [rateInput, setRateInput] = useState<string>(
    initial?.originalCurrency && initial?.exchangeRate ? formatRate(initial.exchangeRate) : "",
  );
  const [rateSource, setRateSource] = useState<"live" | "last_booking" | "manual" | "bank">(
    initial?.rateSource ?? "live",
  );
  // Tatsächlich abgebuchter Euro-Betrag (nur bei rate_source='bank').
  const [bankInput, setBankInput] = useState<string>(
    initial?.rateSource === "bank" && initial?.bankAmount != null ? formatAmount(initial.bankAmount) : "",
  );
  const onBankChange = (value: string) => setBankInput(value);
  // Voller Fremdbetrag der Kartenzahlung (nur nötig bei rausgerechnetem Privatkauf).
  // Aus einem Outbox-ENTWURF wiederhergestellt (Fund O-3): dessen exchange_rate
  // ist der rohe Schätzkurs, nicht der effektive — ohne den vollen Fremdbetrag
  // als Divisor rechnete der Replay den Kurs falsch. Bei einer gespeicherten
  // Server-Buchung ist das Feld transient (nicht gespeichert) → bleibt leer,
  // dort trägt der bereits effektive exchange_rate den Betrag (siehe Fund C-2).
  const [bankForeignInput, setBankForeignInput] = useState<string>(
    initial?.rateSource === "bank" && initial?.bankForeignAmount != null
      ? formatAmount(initial.bankForeignAmount)
      : "",
  );
  const onBankForeignChange = (value: string) => setBankForeignInput(value);
  // Online geladene Kurse persistent cachen → erste Offline-Buchung einer
  // Währung hat auch ohne frühere Buchung einen Kurs (siehe lib/offline/rate-cache).
  useEffect(() => {
    cacheRates(
      tripId,
      options.filter((o) => o.rate != null).map((o) => ({ code: o.code, rate: o.rate as number })),
    );
  }, [tripId, options]);
  const handleCurrencyChange = (code: string) => {
    setCurrency(code);
    // Bankbetrag gilt je Währung → bei Wechsel zurücksetzen.
    setBankInput("");
    setBankForeignInput("");
    if (code === "EUR") {
      setRateInput("");
      return;
    }
    const opt = options.find((o) => o.code === code);
    // Fallback-Kette: Server-Default (live/letzte Buchung) → Cache → leer (manuell).
    const cached = opt?.rate == null ? getCachedRate(tripId, code) : null;
    const rate = opt?.rate ?? cached;
    setRateInput(rate != null ? formatRate(rate) : "");
    setRateSource(opt?.rate != null && opt.source === "live" ? "live" : "last_booking");
  };
  const onRateChange = (value: string) => {
    setRateInput(value);
    setRateSource("manual");
  };
  const isForeign = currency !== "EUR";
  const rateNum = parseRate(rateInput);
  return {
    currency, rateInput, rateSource, isForeign, rateNum,
    bankInput, onBankChange, bankForeignInput, onBankForeignChange,
    handleCurrencyChange, onRateChange,
  };
}

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
  /** Auf dem Törn aktivierte Fremdwährungen inkl. Default-Kurs (Migration 0041). */
  currencyOptions?: CurrencyChoice[];
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
  currencyOptions = [],
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
          currencyOptions={currencyOptions}
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
          currencyOptions={currencyOptions}
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
  currencyOptions,
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
  currencyOptions: CurrencyChoice[];
  tripStart?: string;
  tripEnd?: string;
  initial?: ExpenseInitial;
  draftId?: string;
}) {
  const vocab = useTripVocab();
  const SPLIT_LABEL = splitLabel(vocab);
  // Die eigene Währung einer geladenen (Edit/Draft) Buchung muss immer wählbar
  // sein, auch wenn der Törn sie inzwischen deaktiviert hat — sonst würde das
  // Speichern sie als Euro verbuchen.
  const effectiveCurrencyOptions = withBookingCurrency(currencyOptions, initial?.originalCurrency, initial?.exchangeRate);
  const { currency, rateInput, rateSource, isForeign, rateNum, bankInput, onBankChange, bankForeignInput, onBankForeignChange, handleCurrencyChange, onRateChange } =
    useCurrencyState(tripId, effectiveCurrencyOptions, initial);
  const unit = isForeign ? currency : "€";
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
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
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
  // (= Tranchen-Betrag), Beschreibung (= Tranchen-Name) und Kategorie
  // (= Törn-Kategorie „Yacht", sofern vorhanden) vor — der typische Fall
  // „Charter-Überweisung an den Vercharterer erfassen". Datum bleibt wie
  // sonst auf heute. Wir merken uns die zuletzt auto-gefüllten Werte, damit ein
  // Tranchen-Wechsel sie aktualisieren darf, manuell Eingegebenes aber in Ruhe
  // bleibt (und beim Zurücksetzen auf „Keine" nur Auto-Werte wieder geleert
  // werden).
  const yachtCategoryId = useMemo(
    () => categories.find((c) => /yacht/i.test(c.name))?.id ?? null,
    [categories],
  );
  const trancheAutofillRef = useRef<TrancheAutofillState | null>(null);
  const handleTrancheSelect = (tranche: TrancheOption | null) => {
    const result = computeTrancheAutofill({
      tranche: tranche ? { ...tranche, categoryId: yachtCategoryId } : null,
      current: { amount, description, categoryId },
      previous: trancheAutofillRef.current,
      formatAmount,
    });
    setAmount(result.amount);
    setDescription(result.description);
    setCategoryId(result.categoryId);
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

  // Fremdwährung: eingegebene Beträge sind der Fremdbetrag. Der effektive Kurs
  // ist der geschätzte Kurs — ODER, wenn der tatsächliche Bankbetrag eingetragen
  // wurde, Bank/Fremdbetrag. Damit rechnen EUR-Anzeigen (Vorschau, Fat-Finger)
  // und die EUR-Vorschau im CurrencyField. Ohne gültigen Kurs → 0.
  const foreignTotal = isPerPerson ? perPersonSum : safeMathEval(amount) ?? 0;
  // Memoisiert, weil effRate in die previewShares-Dependencies einfließt.
  const effRate = useMemo(
    () => computeEffRate(isForeign, rateNum, bankInput, bankForeignInput, foreignTotal),
    [isForeign, rateNum, bankInput, bankForeignInput, foreignTotal],
  );
  const toEur = (v: number) => (isForeign ? (effRate != null ? foreignToEur(v, effRate) : 0) : v);

  // EUR-Gesamtbetrag für Anzeige/Fat-Finger. Bei „Pro Person" konvertiert der
  // Server JEDEN Teilnehmer einzeln und summiert dann (lib/rates/resolve.ts) —
  // die Vorschau muss das spiegeln, sonst weicht die angezeigte €-Summe um Cents
  // vom tatsächlich gebuchten Betrag ab (Fund C-5). Sonst der einzelne Betrag.
  const eurTotal = isPerPerson
    ? round2(perPersonAmounts.filter((p) => p.amount > 0).reduce((s, p) => s + toEur(p.amount), 0))
    : toEur(foreignTotal);

  // Buchungen vor/nach dem Törn sind erlaubt (Anzahlung, Versicherung,
  // Nachzügler-Rechnung) — nur „An Bord" ergibt dann keinen Sinn, weil am
  // Buchungstag niemand anwesend ist (Server lehnt das ebenfalls ab).
  const dateOutsideTrip =
    !!tripStart && !!tripEnd && (date < tripStart || date > tripEnd);

  // ── Livevorschau der Aufteilung ────────────────────────────────────────
  // Spiegelt mit der exakt gleichen Logik wie der Server (lib/calc/shares.ts)
  // pro Person den Anteil, damit der User VOR dem Speichern sieht, wer wie viel zahlt.
  const previewShares = useMemo(() => {
    // Vorschau rechnet in EUR (Bilanz-Währung) — bei Fremdwährung die
    // eingegebenen Fremdbeträge zum aktuellen Kurs umrechnen.
    const conv = (v: number) => (isForeign ? (effRate != null ? foreignToEur(v, effRate) : 0) : v);
    const baseAmount = isPerPerson ? conv(perPersonSum) : conv(safeMathEval(amount) ?? 0);
    const alc = !isPerPerson ? conv(safeMathEval(alcoholAmount) ?? 0) : 0;
    const tip = isPerPerson ? conv(safeMathEval(tipAmount) ?? 0) : 0;
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
        .map((p) => ({ personId: p.personId, amount: conv(p.amount) })),
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
    isForeign,
    effRate,
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
      getTotal: () => eurTotal,
      fatFingerNoun: "Buchung",
    });

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="split_type" value={splitType} />
      {/* Draft behält seinen idempotency_key (= draftId); frischer Create nutzt den Zufalls-Key. */}
      {!isEdit && <input type="hidden" name="idempotency_key" value={isDraft ? draftId : idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup
        label="Datum"
        htmlFor="date"
        error={fieldError("date")}
        hint={
          dateOutsideTrip && splitType !== "on_board"
            ? `Liegt außerhalb des ${vocab.trip}zeitraums — ok, z. B. für Anzahlung oder Versicherung.`
            : undefined
        }
      >
        <input
          id="date" name="date" type="date" required
          value={date}
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
          selectedId={categoryId}
          onSelect={setCategoryId}
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

      <FieldGroup label={`Betrag (${unit})`} htmlFor="amount" error={fieldError("amount")} hint={isPerPerson ? "Wird aus den Einzelbeträgen unten berechnet." : "Rechnen erlaubt, z. B. 47,30 − 6,00 (Privatkäufe rausrechnen)."}>
        <input
          id="amount" name="amount" type="text" required={!isPerPerson}
          inputMode="text" pattern="[0-9.,+*/() -]+"
          autoComplete="off"
          value={displayAmount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => { if (!isPerPerson) evalAmountField(amount, setAmount); }}
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

      {effectiveCurrencyOptions.length > 0 && (
        <CurrencyField
          options={effectiveCurrencyOptions}
          currency={currency}
          onCurrencyChange={handleCurrencyChange}
          rateInput={rateInput}
          onRateChange={onRateChange}
          rateSource={rateSource}
          bankInput={bankInput}
          onBankChange={onBankChange}
          bankForeignInput={bankForeignInput}
          onBankForeignChange={onBankForeignChange}
          eurPreview={effRate != null && foreignTotal > 0 ? eurTotal : null}
          error={fieldError("exchange_rate")}
        />
      )}

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
        {splitType === "on_board" && dateOutsideTrip && (
          <p role="status" className="mt-2 rounded-md border border-gold/30 bg-gold-soft px-3 py-2 text-sm text-ink">
            ⚠ „{SPLIT_LABEL.on_board}“ zählt nur Personen, die am Buchungstag dabei
            sind — außerhalb des {vocab.trip}zeitraums ist das niemand und die
            Ausgabe würde niemandem zugeteilt. Bitte Datum oder Aufteilung anpassen.
          </p>
        )}
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
          unit={unit}
        />
      )}

      {/* Trinkgeld ist semantisch nur bei "Pro Person" sinnvoll (Restaurant-Szenario). */}
      {isPerPerson && (
        <>
          <FieldGroup label={`Trinkgeld (${unit})`} htmlFor="tip_amount" error={fieldError("tip_amount")}>
            <input
              id="tip_amount" name="tip_amount" type="text"
              inputMode="text" pattern="([0-9.,+*/() -]+)?"
              autoComplete="off"
              placeholder="0,00"
              value={tipAmount}
              onChange={(e) => setTipAmount(e.target.value)}
              onBlur={() => evalAmountField(tipAmount, setTipAmount)}
              aria-invalid={isInvalid("tip_amount") || undefined}
              className={cn(inputCls, isInvalid("tip_amount") && "border-danger ring-2 ring-danger/20")}
            />
          </FieldGroup>

          {/* Hidden-Input für FormData — Toggle ist Client-State. */}
          <input type="hidden" name="tip_distribution" value={tipDistribution} />

          {/* Verteilungs-Toggle nur sichtbar wenn überhaupt Trinkgeld gesetzt ist. */}
          {(() => {
            const tip = safeMathEval(tipAmount) ?? 0;
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
            <FieldGroup label={`Alkoholanteil (${unit})`} htmlFor="alcohol_amount" error={fieldError("alcohol_amount")} hint="Wird auf alle verteilt, die Alkohol mittrinken; Rest nach Aufteilung.">
              <input
                id="alcohol_amount" name="alcohol_amount" type="text"
                inputMode="text" pattern="([0-9.,+*/() -]+)?"
                autoComplete="off"
                placeholder="0,00"
                value={alcoholAmount}
                onChange={(e) => setAlcoholAmount(e.target.value)}
                onBlur={() => evalAmountField(alcoholAmount, setAlcoholAmount)}
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
  currencyOptions,
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
  currencyOptions: CurrencyChoice[];
  tripStart?: string;
  tripEnd?: string;
  initial?: CreditInitial;
  draftId?: string;
}) {
  const vocab = useTripVocab();
  const isDraft = !!draftId;
  const isEdit = !!initial && !isDraft;
  const effectiveCurrencyOptions = withBookingCurrency(currencyOptions, initial?.originalCurrency, initial?.exchangeRate);
  const { currency, rateInput, rateSource, isForeign, rateNum, bankInput, onBankChange, bankForeignInput, onBankForeignChange, handleCurrencyChange, onRateChange } =
    useCurrencyState(tripId, effectiveCurrencyOptions, initial);
  const unit = isForeign ? currency : "€";

  // Controlled-State, damit React-19's Form-Reset Eingaben bei Fehlern nicht löscht.
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial ? formatAmount(initial.amount) : "");

  // Effektiver Kurs (Bankbetrag gewinnt über geschätzten Kurs) → EUR-Anzeigen.
  const foreignTotal = safeMathEval(amount) ?? 0;
  const effRate = computeEffRate(isForeign, rateNum, bankInput, bankForeignInput, foreignTotal);
  const toEur = (v: number) => (isForeign ? (effRate != null ? foreignToEur(v, effRate) : 0) : v);

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
      getTotal: () => toEur(safeMathEval(amount) ?? 0),
      fatFingerNoun: "Gutschrift",
    });

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="trip_id" value={tripId} />
      {!isEdit && <input type="hidden" name="idempotency_key" value={isDraft ? draftId : idempotencyKey} />}
      {isEdit && <input type="hidden" name="transaction_id" value={initial!.transactionId} />}

      <FieldGroup
        label="Datum"
        htmlFor="date"
        error={fieldError("date")}
        hint={
          !!tripStart && !!tripEnd && (date < tripStart || date > tripEnd)
            ? `Liegt außerhalb des ${vocab.trip}zeitraums — ok, z. B. für eine Anzahlung vorab.`
            : undefined
        }
      >
        <input id="date" name="date" type="date" required
          value={date}
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

      <FieldGroup label={`Betrag (${unit})`} htmlFor="amount" error={fieldError("amount")} hint="Rechnen erlaubt, z. B. 240,00 / 4.">
        <input
          id="amount" name="amount" type="text" required
          inputMode="text" pattern="[0-9.,+*/() -]+"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => evalAmountField(amount, setAmount)}
          placeholder="0,00"
          aria-invalid={isInvalid("amount") || undefined}
          className={cn(inputCls, isInvalid("amount") && "border-danger ring-2 ring-danger/20")}
        />
      </FieldGroup>

      {effectiveCurrencyOptions.length > 0 && (
        <CurrencyField
          options={effectiveCurrencyOptions}
          currency={currency}
          onCurrencyChange={handleCurrencyChange}
          rateInput={rateInput}
          onRateChange={onRateChange}
          rateSource={rateSource}
          bankInput={bankInput}
          onBankChange={onBankChange}
          bankForeignInput={bankForeignInput}
          onBankForeignChange={onBankForeignChange}
          eurPreview={effRate != null && foreignTotal > 0 ? toEur(foreignTotal) : null}
          error={fieldError("exchange_rate")}
        />
      )}

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
