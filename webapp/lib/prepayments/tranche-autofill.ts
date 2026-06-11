/**
 * Reine Logik für die Vorbelegung des Ausgabe-Formulars aus einer gewählten
 * Anzahlungstranche (Charter-Überweisung an den Vercharterer erfassen).
 *
 * „Smart overwrite": Es werden nur Felder gesetzt, die leer sind ODER noch den
 * zuletzt automatisch gefüllten Wert tragen. Damit darf ein Tranchen-Wechsel
 * die Vorbelegung aktualisieren, manuell Eingegebenes bleibt aber unangetastet.
 * Beim Zurücksetzen auf „Keine" werden nur die Auto-Werte wieder geleert.
 *
 * Außerhalb der Komponente gehalten, damit die kniffligen Überschreib-Regeln
 * unabhängig vom React-Render-Pfad getestet werden können (Vitest).
 */

export type TrancheAutofillState = {
  amount: string;
  description: string;
  /** Kategorie-ID; null = „Keine" ausgewählt. */
  categoryId: string | null;
};

export interface TrancheAutofillInput {
  /**
   * Gewählte Tranche (null = „Keine"). `amount` = Tranchen-Betrag (number),
   * `categoryId` = Vorbelegungs-Kategorie (die Törn-Kategorie „Yacht");
   * null/undefined, wenn der Törn keine solche Kategorie (mehr) hat.
   */
  tranche: { label: string; amount?: number; categoryId?: string | null } | null;
  /** Aktuelle Feldwerte im Formular. */
  current: TrancheAutofillState;
  /** Zuletzt automatisch gefüllte Werte; null, wenn noch nie / zurückgesetzt. */
  previous: TrancheAutofillState | null;
  /** Number → deutsches Komma-Format (z. B. die Form-eigene `formatAmount`). */
  formatAmount: (n: number) => string;
}

export interface TrancheAutofillResult {
  amount: string;
  description: string;
  categoryId: string | null;
  /** Neuer „previous"-Stand; null, wenn auf „Keine" zurückgesetzt. */
  autofill: TrancheAutofillState | null;
}

export function computeTrancheAutofill({
  tranche,
  current,
  previous,
  formatAmount,
}: TrancheAutofillInput): TrancheAutofillResult {
  // Ein Feld darf überschrieben werden, wenn es leer ist oder noch genau den
  // zuletzt auto-gefüllten Wert trägt (= vom User nicht angefasst).
  const isAutoOrEmpty = (value: string, key: "amount" | "description") =>
    value === "" || (previous != null && value === previous[key]);
  const categoryAutoOrEmpty =
    current.categoryId == null ||
    (previous != null && current.categoryId === previous.categoryId);

  if (!tranche) {
    // Zurück auf „Keine": Auto-Werte leeren, manuell Eingegebenes behalten.
    return {
      amount: previous && current.amount === previous.amount ? "" : current.amount,
      description:
        previous && current.description === previous.description ? "" : current.description,
      categoryId:
        previous && current.categoryId === previous.categoryId ? null : current.categoryId,
      autofill: null,
    };
  }

  const nextAmount = tranche.amount != null ? formatAmount(tranche.amount) : "";
  const nextDescription = tranche.label;
  const nextCategoryId = tranche.categoryId ?? null;
  return {
    amount: nextAmount && isAutoOrEmpty(current.amount, "amount") ? nextAmount : current.amount,
    description: isAutoOrEmpty(current.description, "description")
      ? nextDescription
      : current.description,
    categoryId:
      nextCategoryId != null && categoryAutoOrEmpty ? nextCategoryId : current.categoryId,
    autofill: { amount: nextAmount, description: nextDescription, categoryId: nextCategoryId },
  };
}
