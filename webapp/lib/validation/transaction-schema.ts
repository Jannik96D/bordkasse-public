/**
 * Zod-Schemas für Transaktionen — gespiegelt zur SQL-Constraints aus
 * 0001_init.sql + Validierungsregeln aus docs/calculation-rules.md.
 */

import { z } from "zod";

const DateString = z
  .string({ error: "Bitte Datum wählen." })
  .min(1, "Bitte Datum wählen.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD.");

const decimalString = (v: unknown) =>
  typeof v === "string" ? v.replace(",", ".") : v;

// Plausibilitäts-Obergrenze gegen Tippfehler (z. B. eine Null zu viel),
// die sonst sofort die ganze Bilanz verzerren. 1 Mio € liegt weit über
// jedem realistischen Törn-Posten, fängt aber "500000 statt 50" ab.
const MAX_AMOUNT = 1_000_000;
const MAX_AMOUNT_MSG = "Betrag ist unrealistisch hoch — bitte prüfen (max. 1.000.000 €).";

const Amount = z.preprocess(
  decimalString,
  z.coerce.number().positive("Betrag muss > 0 sein.").max(MAX_AMOUNT, MAX_AMOUNT_MSG),
);
const NonNegativeAmount = z.preprocess(
  decimalString,
  z.coerce.number().nonnegative("Betrag darf nicht negativ sein.").max(MAX_AMOUNT, MAX_AMOUNT_MSG),
);
const Uuid = z.string().uuid("Ungültige Auswahl.");

/**
 * UUID-Feld mit feldspezifischer Meldung wenn leer.
 * Leerer String (= Pflichtfeld nicht ausgefüllt) wird klar von „echtem"
 * UUID-Format-Fehler unterschieden. Wird benötigt, weil PersonSelect /
 * CategorySelect Hidden-Inputs nutzen, die kein HTML-`required` unterstützen.
 */
const requiredUuid = (label: string) =>
  z
    .string({ error: `${label}: bitte auswählen.` })
    .min(1, `${label}: bitte auswählen.`)
    .uuid(`${label}: ungültige Auswahl.`);

/** Eintrag der Pro-Person-Beträge. JSON-Form: [{ person_id, amount }] */
const ParticipantAmount = z.object({
  person_id: Uuid,
  amount: NonNegativeAmount,
}).refine(
  (p) => p.amount === 0 || p.amount >= 0.01,
  { message: "Pro-Person-Beträge müssen mindestens 1 Cent sein.", path: ["amount"] },
);

export const ExpenseSchema = z
  .object({
    trip_id: requiredUuid("Törn"),
    date: DateString,
    description: z.string().trim().min(1, "Beschreibung darf nicht leer sein.").max(120),
    category_id: Uuid.optional().nullable(),
    paid_by: requiredUuid("Bezahlt von"),
    // Bei split_type='per_person' wird amount aus participant_amounts abgeleitet
    // und darf hier 0 sein — das per_person-Refine fängt fehlende Einträge ab.
    amount: NonNegativeAmount,
    alcohol_amount: NonNegativeAmount.default(0),
    tip_amount: NonNegativeAmount.default(0),
    tip_distribution: z.enum(["proportional", "equal"]).default("proportional"),
    split_type: z.enum([
      "equal",
      "on_board",
      "time_proportional",
      "individual",
      "per_person",
    ]),
    participant_ids: z.array(Uuid).default([]),
    participant_amounts: z.preprocess(
      (v) => {
        // null/undefined → leeres Array (Feld war nicht im FormData, weil
        // split_type ≠ per_person). Sonst: String mit JSON parsen oder als
        // Array durchreichen.
        if (v == null) return [];
        if (typeof v !== "string") return v;
        if (!v) return [];
        try { return JSON.parse(v); } catch { return v; }
      },
      z.array(ParticipantAmount).default([]),
    ),
    /**
     * Optional: ordnet die Buchung einer Anzahlungs-Tranche zu (Migration 0023).
     * Wenn gesetzt, landet die Buchung im Anzahlungs-Pool statt in der Bordkasse.
     * Typischer Use-Case: Skipper bucht die Yachtanzahlung und ordnet sie der
     * passenden Tranche zu.
     */
    tranche_id: z.string().uuid().optional().nullable(),
    idempotency_key: Uuid.optional(),
  })
  .refine(
    (d) => d.split_type === "per_person" || d.amount > 0,
    { message: "Betrag muss > 0 sein.", path: ["amount"] },
  )
  .refine((d) => d.alcohol_amount <= d.amount, {
    message: "Alkohol-Anteil darf nicht größer als Gesamtbetrag sein.",
    path: ["alcohol_amount"],
  })
  .refine(
    (d) => d.split_type !== "individual" || d.participant_ids.length > 0,
    { message: "Bei 'Individuell' mindestens eine Person markieren.", path: ["participant_ids"] },
  )
  .refine(
    (d) =>
      d.split_type !== "per_person" ||
      d.participant_amounts.some((p) => p.amount > 0),
    {
      message: "Bei 'Pro Person' mindestens eine Person mit Betrag > 0 eintragen.",
      path: ["participant_amounts"],
    },
  );

export const CreditSchema = z
  .object({
    trip_id: requiredUuid("Törn"),
    date: DateString,
    description: z.string().trim().max(120).optional().or(z.literal("")),
    amount: Amount,
    credit_from: requiredUuid("Zahlt (Von)"),
    credit_to: requiredUuid("Empfängt (An)").nullable(), // null = "Alle"
    /** Optional, siehe ExpenseSchema. */
    tranche_id: z.string().uuid().optional().nullable(),
    idempotency_key: Uuid.optional(),
  })
  .refine((d) => d.credit_to !== d.credit_from, {
    message: "Von und An können nicht dieselbe Person sein.",
    path: ["credit_to"],
  });

export type ExpenseInput = z.infer<typeof ExpenseSchema>;
export type CreditInput = z.infer<typeof CreditSchema>;
