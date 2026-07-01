"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  TransactionForm,
  type ExpenseInitial,
  type CreditInitial,
  type TrancheOption,
} from "./new/transaction-form";
import type { CurrencyChoice } from "./new/transaction-form-parts";
import { get as getOutboxItem, type OutboxItem } from "@/lib/offline/outbox";

type Member = {
  person_id: string;
  display_name: string;
  on_board_from?: string | null;
  on_board_to?: string | null;
  is_alcoholic_effective?: boolean;
};
type Category = { id: string; name: string; icon: string | null };

type FormDataObj = Record<string, string | string[]>;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** Deutsches Komma-Format → Number. Leer/ungültig → 0. */
function num(v: string | string[] | undefined): number {
  const s = str(v);
  if (s === "") return 0;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  return typeof v === "string" && v !== "" ? [v] : [];
}

// Fremdwährung (Migration 0041) aus dem Outbox-Entwurf zurücklesen.
function currencyOrNull(v: string | string[] | undefined): string | null {
  const s = str(v);
  return s && s !== "EUR" ? s : null;
}
function rateOrNull(v: string | string[] | undefined): number | null {
  const s = str(v);
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function rateSourceOrNull(v: string | string[] | undefined): "live" | "manual" | "bank" | null {
  const s = str(v);
  return s === "manual" || s === "bank" || s === "live" ? s : null;
}

/**
 * Übersetzt die rohe Outbox-`formData` einer Ausgabe zurück in die
 * `ExpenseInitial`-Form, mit der das bestehende Form vorbefüllt wird.
 * `transactionId` bleibt leer — im Draft-Modus rendert das Form kein
 * transaction_id-Feld (kein Server-Edit).
 */
function draftToExpenseInitial(d: FormDataObj): ExpenseInitial {
  let participantAmounts: Array<{ personId: string; amount: number }> = [];
  try {
    const parsed = JSON.parse(str(d.participant_amounts) || "[]");
    if (Array.isArray(parsed)) {
      participantAmounts = parsed.map((p: { person_id: string; amount: number }) => ({
        personId: p.person_id,
        amount: p.amount,
      }));
    }
  } catch {
    // kaputtes JSON → leere Liste, Form startet mit leeren Pro-Person-Feldern
  }

  return {
    transactionId: "",
    date: str(d.date),
    description: str(d.description),
    categoryId: str(d.category_id) || null,
    paidBy: str(d.paid_by),
    amount: num(d.amount),
    alcoholAmount: num(d.alcohol_amount),
    tipAmount: num(d.tip_amount),
    tipDistribution: str(d.tip_distribution) === "equal" ? "equal" : "proportional",
    splitType: (str(d.split_type) || "equal") as ExpenseInitial["splitType"],
    participantIds: asArray(d.participant_ids),
    participantAmounts,
    trancheId: str(d.tranche_id) || null,
    originalCurrency: currencyOrNull(d.original_currency),
    exchangeRate: rateOrNull(d.exchange_rate),
    rateSource: rateSourceOrNull(d.rate_source),
    bankAmount: rateOrNull(d.bank_eur_amount),
  };
}

function draftToCreditInitial(d: FormDataObj): CreditInitial {
  const rawTo = str(d.credit_to);
  return {
    transactionId: "",
    date: str(d.date),
    description: str(d.description),
    amount: num(d.amount),
    creditFrom: str(d.credit_from),
    creditTo: rawTo === "ALL" ? null : rawTo || null,
    trancheId: str(d.tranche_id) || null,
    originalCurrency: currencyOrNull(d.original_currency),
    exchangeRate: rateOrNull(d.exchange_rate),
    rateSource: rateSourceOrNull(d.rate_source),
    bankAmount: rateOrNull(d.bank_eur_amount),
  };
}

/**
 * Bearbeitet einen noch nicht gesyncten Outbox-Entwurf. Lädt das Item
 * client-seitig aus IndexedDB (Server kennt die Outbox nicht), leitet die
 * Vorbefüllung ab und rendert das normale Buchungsform im Draft-Modus
 * (`draftId` → Submit überschreibt den Outbox-Eintrag statt Server-Call).
 */
export function DraftEditor({
  draftId,
  tripId,
  isSkipper,
  members,
  categories,
  currentPersonId,
  tranches,
  canEditTranche,
  currencyOptions,
  tripStart,
  tripEnd,
}: {
  draftId: string;
  tripId: string;
  isSkipper: boolean;
  members: Member[];
  categories: Category[];
  currentPersonId?: string;
  tranches?: TrancheOption[];
  canEditTranche: boolean;
  currencyOptions?: CurrencyChoice[];
  tripStart?: string;
  tripEnd?: string;
}) {
  // undefined = lädt noch, null = nicht (mehr) vorhanden, sonst das Item.
  const [item, setItem] = useState<OutboxItem | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getOutboxItem(draftId)
      .then((i) => {
        if (!cancelled) setItem(i ?? null);
      })
      .catch(() => {
        if (!cancelled) setItem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  if (item === undefined) {
    return (
      <p className="py-10 text-center text-sm text-ink-soft" role="status">
        Entwurf wird geladen …
      </p>
    );
  }

  if (item === null) {
    // Schon gesynct oder verworfen → kein Entwurf mehr zum Bearbeiten.
    return (
      <div className="rounded-lg border border-dashed border-rule p-8 text-center">
        <p className="font-medium">Entwurf nicht gefunden</p>
        <p className="mt-2 text-sm text-ink-soft">
          Diese Buchung wurde inzwischen übertragen oder verworfen. Bearbeite sie
          bei Bedarf über die Buchungsliste.
        </p>
        <Link
          href={`/trips/${tripId}/transactions`}
          className="mt-4 inline-flex min-h-touch items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
        >
          Zur Buchungsliste
        </Link>
      </div>
    );
  }

  const isExpense = item.kind === "expense";

  return (
    <TransactionForm
      tripId={tripId}
      isSkipper={isSkipper}
      currentPersonId={currentPersonId}
      tripStart={tripStart}
      tripEnd={tripEnd}
      members={members}
      categories={categories}
      tranches={tranches}
      canEditTranche={canEditTranche}
      currencyOptions={currencyOptions}
      expenseInitial={isExpense ? draftToExpenseInitial(item.formData) : undefined}
      creditInitial={!isExpense ? draftToCreditInitial(item.formData) : undefined}
      draftId={draftId}
    />
  );
}
