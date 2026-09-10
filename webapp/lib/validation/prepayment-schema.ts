/**
 * Zod-Schemas für Anzahlungstranchen — gespiegelt zur Migration 0023.
 * Spec: docs/prepayments.md
 */

import { z } from "zod";
import { parseAmountDe } from "@/lib/utils";

// Tausenderpunkte mitverstehen: „3.700,00" wurde als `NaN` abgelehnt und
// „3.700" stillschweigend zu 3.7 — bei der Anzahlungs-Gesamtsumme also
// Charter-Soll 3,70 € statt 3.700 €. Details in parseAmountDe.
const decimalString = (v: unknown) => {
  if (typeof v !== "string") return v;
  const parsed = parseAmountDe(v);
  return parsed === null ? v : parsed;
};

const Amount = z.preprocess(
  decimalString,
  z.coerce.number().nonnegative("Betrag darf nicht negativ sein."),
);
const PositiveAmount = z.preprocess(
  decimalString,
  z.coerce.number().positive("Betrag muss > 0 sein."),
);
const Uuid = z.string().uuid("Ungültige Auswahl.");
const DateString = z
  .string({ error: "Bitte Datum wählen." })
  .min(1, "Bitte Datum wählen.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD.");

const SplitMethod = z.enum([
  "gleichmaessig",
  "zeitanteilig",
  "individuell",
  "kojen",
]);

export const CabinTypeInput = z.object({
  id: Uuid.optional(),
  label: z.string().trim().min(1, "Label fehlt.").max(60),
  price_per_person: Amount,
  capacity: z.coerce.number().int().positive("Kapazität muss ≥ 1 sein."),
  sort_order: z.coerce.number().int().nonnegative().default(0),
});

export const ObligationInput = z.object({
  person_id: Uuid,
  total_amount: Amount,
  cabin_type_id: Uuid.optional().nullable(),
});

export const PlanSchema = z
  .object({
    trip_id: Uuid,
    split_method: SplitMethod,
    total_amount: Amount,
    /** Wer hat die Yachtanzahlung vorgestreckt? NULL/undefined = Trip-Skipper. */
    advancer_person_id: Uuid.optional().nullable(),
    wero_id: z.string().trim().max(120).optional().or(z.literal("")),
    whatsapp_template: z.string().trim().max(2000).optional().or(z.literal("")),
    cabin_types: z.array(CabinTypeInput).default([]),
    obligations: z.array(ObligationInput).default([]),
  })
  .refine(
    (d) => d.split_method !== "kojen" || d.cabin_types.length > 0,
    { message: "Bei 'Nach Kojen' mindestens einen Kojentyp definieren.", path: ["cabin_types"] },
  )
  // Die Gesamtsumme ist das Charter-Soll (was der Vorstrecker dem
  // Vercharterer schuldet) und damit für JEDE Aufteilungsmethode Pflicht —
  // auch für „individuell"/„kojen", wo die Sollbeträge aus Einzel-/Kojen-
  // preisen kommen. Vorher durfte das Feld dort leer bleiben und landete als
  // 0 in der DB; damit rechneten Tranchen-Vorbelegung (Betrag 0,00 €),
  // Charter-Banner, Fortschritts-Prozent und Vorstrecker-Erinnerung mit 0.
  // Sie darf von Σ Soll abweichen (die Differenz läuft über die Bordkasse) —
  // nur eben nicht 0 sein.
  .refine((d) => d.total_amount > 0, {
    message: "Gesamtsumme der Anzahlung muss > 0 € sein.",
    path: ["total_amount"],
  });

export const TrancheInput = z.object({
  id: Uuid.optional(),
  due_date: DateString,
  label: z.string().trim().min(1, "Label fehlt.").max(60),
  percent: z.preprocess(decimalString, z.coerce.number().positive().max(100)),
  wero_request_link: z.string().trim().max(500).optional().or(z.literal("")),
  sort_order: z.coerce.number().int().nonnegative().default(0),
});

export const TranchesSchema = z
  .object({
    trip_id: Uuid,
    tranches: z.array(TrancheInput).min(1, "Mindestens eine Tranche definieren."),
  })
  .refine(
    (d) => {
      const sum = d.tranches.reduce((s, t) => s + t.percent, 0);
      return Math.abs(sum - 100) <= 0.01;
    },
    { message: "Summe aller Tranchenprozente muss 100 % ergeben.", path: ["tranches"] },
  );

export const RecordPaymentSchema = z.object({
  trip_id: Uuid,
  tranche_id: Uuid,
  person_id: Uuid,
  amount: PositiveAmount,
  date: DateString,
  note: z.string().trim().max(120).optional().or(z.literal("")),
  /** Bei Überzahlung: optional zweite Tranche, auf die der Rest umgebucht wird. */
  overflow_tranche_id: Uuid.optional().nullable(),
  idempotency_key: Uuid.optional(),
});

export const ReplaceMemberSchema = z
  .object({
    trip_id: Uuid,
    old_person_id: Uuid,
    // Name optional — fehlt er, wird er aus der E-Mail abgeleitet (analog
    // InviteSchema). Ungültig ist nur „beides leer".
    new_display_name: z.string().trim().max(80).optional().or(z.literal("")),
    new_email: z.string().email().optional().or(z.literal("")),
    // Client-generierte ID für die neue Person (Idempotenz — Fund 3,
    // Grill-Review beim UI-Anbinden): stabil über Retries desselben
    // Form-Submits. ⚠️ NUR als Wunsch-ID für eine NEUANLAGE zu behandeln —
    // der Wert ist client-kontrolliert und darf niemals eine BESTEHENDE
    // persons-Zeile adressieren (Guard `assertFreshPersonId` in
    // replaceMember, Fund F1).
    new_person_id: Uuid.optional(),
    // Wechseldatum für den Austausch mitten im Törn (Variante b): A bleibt
    // in der Crew und ist bis zu diesem Tag an Bord, B ab diesem Tag. Leer
    // = Austausch vor Törnbeginn (A wird vollständig aus der Crew entfernt).
    handover_date: DateString.optional().or(z.literal("")),
  })
  .refine(
    (d) => !!d.new_email || !!(d.new_display_name && d.new_display_name.length >= 1),
    { message: "Entweder E-Mail oder Name angeben.", path: ["new_display_name"] },
  );

export type PlanInput = z.infer<typeof PlanSchema>;
export type TranchesInput = z.infer<typeof TranchesSchema>;
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;
export type ReplaceMemberInput = z.infer<typeof ReplaceMemberSchema>;
export type CabinTypeInputT = z.infer<typeof CabinTypeInput>;
export type ObligationInputT = z.infer<typeof ObligationInput>;
export type TrancheInputT = z.infer<typeof TrancheInput>;
export type PrepaymentSplitMethod = z.infer<typeof SplitMethod>;
