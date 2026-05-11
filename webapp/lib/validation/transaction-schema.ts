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

const Amount = z.preprocess(decimalString, z.coerce.number().positive("Betrag muss > 0 sein."));
const NonNegativeAmount = z.preprocess(
  decimalString,
  z.coerce.number().nonnegative("Betrag darf nicht negativ sein."),
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

export const ExpenseSchema = z
  .object({
    trip_id: requiredUuid("Törn"),
    date: DateString,
    description: z.string().trim().min(1, "Beschreibung darf nicht leer sein.").max(120),
    category_id: Uuid.optional().nullable(),
    paid_by: requiredUuid("Bezahlt von"),
    amount: Amount,
    alcohol_amount: NonNegativeAmount.default(0),
    split_type: z.enum(["equal", "on_board", "time_proportional", "individual"]),
    participant_ids: z.array(Uuid).default([]),
    idempotency_key: Uuid.optional(),
  })
  .refine((d) => d.alcohol_amount <= d.amount, {
    message: "Alkohol-Anteil darf nicht größer als Gesamtbetrag sein.",
    path: ["alcohol_amount"],
  })
  .refine(
    (d) => d.split_type !== "individual" || d.participant_ids.length > 0,
    { message: "Bei 'Individuell' mindestens eine Person markieren.", path: ["participant_ids"] },
  );

export const CreditSchema = z
  .object({
    trip_id: requiredUuid("Törn"),
    date: DateString,
    description: z.string().trim().max(120).optional().or(z.literal("")),
    amount: Amount,
    credit_from: requiredUuid("Zahlt (Von)"),
    credit_to: requiredUuid("Empfängt (An)").nullable(), // null = "Alle"
    idempotency_key: Uuid.optional(),
  })
  .refine((d) => d.credit_to !== d.credit_from, {
    message: "Von und An können nicht dieselbe Person sein.",
    path: ["credit_to"],
  });

export type ExpenseInput = z.infer<typeof ExpenseSchema>;
export type CreditInput = z.infer<typeof CreditSchema>;
