"use client";

/**
 * Posten anlegen / bearbeiten (Skipper/Admin). Schreibt über `saveItem`
 * (JSON im Feld `payload`). Der Server bleibt Autorität — dieses Formular
 * zeigt gesperrte Änderungen (nach Anbieter-Zahlung / Gutschriften) als
 * erklärenden Hinweis, statt Felder stumm wegzulassen.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info, RefreshCw } from "lucide-react";
import { Modal } from "@/components/modal";
import { CategorySelect } from "@/components/category-select";
import { useToast } from "@/components/toast-provider";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatAmount, formatEuro } from "@/lib/utils";
import {
  buildSaveItemPayload,
  defaultItemCategoryId,
  evalItemAmount,
  individuellDiffCents,
  itemLocks,
  type ItemFormState,
} from "@/lib/prepayments/item-ui";
import type { ItemSplitType } from "@/lib/calc/prepayment-item-shares";
import { saveItem } from "@/lib/actions/prepayment-items";
import type { PrepaymentItemView } from "@/lib/queries/prepayment-items";

interface Member {
  id: string;
  display_name: string;
}
interface Category {
  id: string;
  name: string;
  icon: string | null;
}

const inputCls =
  "mt-1 min-h-[44px] w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-paper-soft disabled:text-ink-soft aria-[invalid=true]:border-danger";

const SPLITS: { value: ItemSplitType; label: string; hint: string }[] = [
  { value: "gleichmaessig", label: "Gleichmäßig", hint: "Alle zahlen gleich viel." },
  { value: "zeitanteilig", label: "Zeitanteilig", hint: "Nach Anzahl der Tage in der Gruppe." },
  { value: "individuell", label: "Individuell", hint: "Betrag pro Person selbst festlegen." },
];

export function ItemFormModal({
  tripId,
  item,
  members,
  categories,
  defaultPayeeId,
  nextSortOrder,
  onClose,
}: {
  tripId: string;
  /** null = neuer Posten. */
  item: PrepaymentItemView | null;
  members: Member[];
  categories: Category[];
  defaultPayeeId: string | null;
  nextSortOrder: number;
  onClose: () => void;
}) {
  const vocab = useTripVocab();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const locks = useMemo(() => (item ? itemLocks(item) : null), [item]);
  const isEdit = !!item;

  const [state, setState] = useState<ItemFormState>(() => ({
    tripId,
    // Client-generierte ID → Retry derselben Anlage legt keinen zweiten Posten an.
    id: item?.id ?? crypto.randomUUID(),
    categoryId: item ? item.category_id : defaultItemCategoryId(categories),
    label: item?.label ?? "",
    amountText: item ? formatAmount(item.total_amount) : "",
    dueDate: item?.due_date ?? "",
    payeeId: item?.payee_person_id ?? defaultPayeeId ?? members[0]?.id ?? "",
    splitType: item?.split_type ?? "gleichmaessig",
    // Bei Bearbeitung mit dem gespeicherten Soll vorbelegen — auch beim Wechsel
    // von gleichmäßig → individuell ein sinnvoller Ausgangspunkt.
    amounts: Object.fromEntries(
      (item?.cells ?? []).filter((c) => c.soll > 0.005).map((c) => [c.person_id, formatAmount(c.soll)]),
    ),
    redistribute: false,
    sortOrder: item?.sort_order ?? nextSortOrder,
  }));
  const set = <K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  const total = evalItemAmount(state.amountText);
  const diff = individuellDiffCents(total, state.amounts);
  const distributionLocked = locks?.distributionLocked ?? false;
  const payeeLocked = locks?.payeeLocked ?? false;
  const invalid = (f: string) => error?.field === f;

  function submit() {
    setError(null);
    const built = buildSaveItemPayload(state);
    if (!built.ok) {
      setError({ message: built.message, field: built.field });
      return;
    }
    const fd = new FormData();
    fd.set("payload", JSON.stringify(built.payload));
    startTransition(async () => {
      const res = await saveItem({ status: "idle" }, fd);
      if (res.status === "error") {
        setError({ message: res.message, field: res.field });
        return;
      }
      toast.show(isEdit ? "Posten gespeichert." : "Posten angelegt.", { variant: "success" });
      onClose();
      router.refresh();
    });
  }

  const titleId = "item-form-title";
  const errId = "item-form-error";

  return (
    <Modal onClose={onClose} labelledBy={titleId}>
      <h2 id={titleId} className="text-base font-semibold text-primary">
        {isEdit ? "Posten bearbeiten" : "Weiteren Posten anlegen"}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        z. B. Flüge oder Bahn für die An-/Abreise: Eine Person zahlt vorab an den Anbieter, die {vocab.crew} erstattet
        ihr den Anteil.
      </p>

      <div className="mt-4 space-y-4">
        <div className="text-sm">
          <span id="item-cat-label" className="text-ink-soft">Kategorie</span>
          <div className="mt-1" aria-labelledby="item-cat-label">
            <CategorySelect
              name="category_id"
              categories={categories}
              selectedId={state.categoryId}
              onSelect={(id) => set("categoryId", id)}
              placeholder="— Keine —"
            />
          </div>
        </div>

        <label className="block text-sm" htmlFor="item-label">
          <span className="text-ink-soft">Bezeichnung</span>
          <input
            id="item-label"
            value={state.label}
            maxLength={80}
            onChange={(e) => set("label", e.target.value)}
            placeholder="z. B. Flüge"
            aria-invalid={invalid("label")}
            aria-describedby={invalid("label") ? errId : undefined}
            className={inputCls}
          />
        </label>

        <label className="block text-sm" htmlFor="item-amount">
          <span className="text-ink-soft">Betrag (€) — Rechnen möglich, z. B. 1200 − 150,50</span>
          <input
            id="item-amount"
            inputMode="text"
            value={state.amountText}
            disabled={distributionLocked}
            onChange={(e) => set("amountText", e.target.value)}
            onBlur={() => {
              const n = evalItemAmount(state.amountText);
              if (n !== null) set("amountText", formatAmount(n));
            }}
            aria-invalid={invalid("total_amount")}
            aria-describedby={[distributionLocked ? "item-lock-dist" : "", invalid("total_amount") ? errId : ""].filter(Boolean).join(" ") || undefined}
            className={inputCls}
          />
        </label>

        <label className="block text-sm" htmlFor="item-due">
          <span className="text-ink-soft">Fälligkeit beim Anbieter (optional)</span>
          <input
            id="item-due"
            type="date"
            value={state.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
            className={inputCls}
          />
        </label>

        <label className="block text-sm" htmlFor="item-payee">
          <span className="text-ink-soft">Empfänger — wer zahlt vor und bekommt das Geld der {vocab.crew}?</span>
          <select
            id="item-payee"
            value={state.payeeId}
            disabled={payeeLocked}
            onChange={(e) => set("payeeId", e.target.value)}
            aria-invalid={invalid("payee_person_id")}
            aria-describedby={[payeeLocked ? "item-lock-payee" : "", invalid("payee_person_id") ? errId : ""].filter(Boolean).join(" ") || undefined}
            className={inputCls}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name}</option>
            ))}
          </select>
        </label>

        <fieldset className="text-sm" disabled={distributionLocked}>
          <legend className="text-ink-soft">Aufteilung</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {SPLITS.map((o) => {
              const checked = state.splitType === o.value;
              return (
                <label
                  key={o.value}
                  className={`flex min-h-[44px] cursor-pointer flex-col rounded-md border px-3 py-2 focus-within:ring-2 focus-within:ring-primary/20 ${
                    checked ? "border-primary bg-navy-light/30" : "border-rule bg-paper"
                  } ${distributionLocked ? "cursor-not-allowed opacity-70" : ""}`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name="item-split"
                      value={o.value}
                      checked={checked}
                      onChange={() => set("splitType", o.value)}
                      className="h-4 w-4 accent-primary"
                    />
                    {o.label}
                  </span>
                  <span className="mt-0.5 text-xs text-ink-soft">{o.hint}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            „{vocab.onBoard}“ gibt es für Posten nicht — ein Posten hat kein Buchungsdatum, an dem sich die Anwesenheit
            prüfen ließe.
          </p>
        </fieldset>

        {state.splitType === "individuell" && (
          <fieldset className="rounded-md border border-rule p-3 text-sm" disabled={distributionLocked}>
            <legend className="px-1 text-ink-soft">Einzelbeträge</legend>
            <ul className="space-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <label htmlFor={`item-amt-${m.id}`} className="min-w-0 flex-1 truncate">{m.display_name}</label>
                  <input
                    id={`item-amt-${m.id}`}
                    inputMode="text"
                    value={state.amounts[m.id] ?? ""}
                    placeholder="0,00"
                    onChange={(e) => set("amounts", { ...state.amounts, [m.id]: e.target.value })}
                    onBlur={() => {
                      const raw = state.amounts[m.id] ?? "";
                      const n = evalItemAmount(raw);
                      if (n !== null) set("amounts", { ...state.amounts, [m.id]: formatAmount(n) });
                    }}
                    className="min-h-[44px] w-28 rounded-md border border-rule px-3 py-2 text-right tabular-nums focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-paper-soft"
                  />
                </li>
              ))}
            </ul>
            <p
              role="status"
              aria-live="polite"
              className={`mt-3 text-xs ${diff === 0 && total ? "text-success" : "text-danger"}`}
            >
              {diff === 0 && total
                ? "✓ Die Einzelbeträge ergeben genau den Betrag des Postens."
                : `Die Einzelbeträge weichen um ${diff > 0 ? "+" : "−"}${formatEuro(Math.abs(diff) / 100)} vom Betrag des Postens ab. Sie müssen genau aufgehen.`}
            </p>
          </fieldset>
        )}

        {isEdit && !distributionLocked && state.splitType !== "individuell" && (
          <label className="flex min-h-[44px] items-start gap-3 rounded-md bg-paper-soft p-3 text-sm" htmlFor="item-redistribute">
            <input
              id="item-redistribute"
              type="checkbox"
              checked={state.redistribute}
              onChange={(e) => set("redistribute", e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-primary"
            />
            <span>
              <span className="font-medium">Soll neu verteilen</span>
              <span className="mt-0.5 block text-xs text-ink-soft">
                Rechnet das Soll aus der aktuellen {vocab.crew} neu. Sinnvoll nach einem Crewwechsel oder wenn Personen
                dazugekommen oder weggefallen sind. Ohne Haken bleibt das gespeicherte Soll unverändert, wenn du nur
                Bezeichnung, Kategorie oder Fälligkeit änderst.
              </span>
            </span>
          </label>
        )}

        {distributionLocked && locks?.distributionReason && (
          <p id="item-lock-dist" className="flex gap-2 rounded-md bg-paper-soft p-3 text-xs text-ink-soft">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{locks.distributionReason}</span>
          </p>
        )}
        {payeeLocked && locks?.payeeReason && (
          <p id="item-lock-payee" className="flex gap-2 rounded-md bg-paper-soft p-3 text-xs text-ink-soft">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{locks.payeeReason}</span>
          </p>
        )}

        {error && (
          <p id={errId} role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {error.message}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          >
            {pending && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Speichern
          </button>
        </div>
      </div>
    </Modal>
  );
}
