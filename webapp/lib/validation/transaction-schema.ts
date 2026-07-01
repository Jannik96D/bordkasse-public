/**
 * Zod-Schemas für Transaktionen — gespiegelt zur SQL-Constraints aus
 * 0001_init.sql + Validierungsregeln aus docs/calculation-rules.md.
 */

import { z } from "zod";
import { safeMathEval } from "@/lib/utils/math-eval";
import { isSupportedCurrency } from "@/lib/rates/currencies";

const DateString = z
  .string({ error: "Bitte Datum wählen." })
  .min(1, "Bitte Datum wählen.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD.");

/**
 * Wandelt eine Betragseingabe für Zod vor: akzeptiert neben "12,50" auch
 * Rechen-Ausdrücke wie "47,30 - 6,00" (Pfand/Privatkäufe direkt vom Bon
 * rausrechnen) — ausgewertet via safeMathEval (CSP-sicher, kein eval).
 * Dient als Sicherheitsnetz für Submits ohne vorheriges onBlur (Enter,
 * Autofill); im Formular wertet das Feld bereits beim Verlassen aus.
 * - leere Eingabe → unverändert (coerce/Default greifen wie bisher)
 * - gültiger Ausdruck/Zahl → berechnete Zahl (safeMathEval normalisiert Komma)
 * - ungültige nicht-leere Eingabe → unverändert durchgereicht → coerce → NaN
 *   → bestehende Fehlermeldung (positive/nonnegative)
 */
const evalExpr = (v: unknown) => {
  if (typeof v !== "string") return v;
  if (v.trim() === "") return v;
  const result = safeMathEval(v);
  return result === null ? v : result;
};

// Plausibilitäts-Obergrenze gegen Tippfehler (z. B. eine Null zu viel),
// die sonst sofort die ganze Bilanz verzerren. 1 Mio € liegt weit über
// jedem realistischen Törn-Posten, fängt aber "500000 statt 50" ab.
const MAX_AMOUNT = 1_000_000;
const MAX_AMOUNT_MSG = "Betrag ist unrealistisch hoch, bitte prüfen (max. 1.000.000 €).";

const Amount = z.preprocess(
  evalExpr,
  z.coerce.number().positive("Betrag muss > 0 sein.").max(MAX_AMOUNT, MAX_AMOUNT_MSG),
);
const NonNegativeAmount = z.preprocess(
  evalExpr,
  z.coerce.number().nonnegative("Betrag darf nicht negativ sein.").max(MAX_AMOUNT, MAX_AMOUNT_MSG),
);
const Uuid = z.string().uuid("Ungültige Auswahl.");

// ── Fremdwährung (Migration 0041) ─────────────────────────────────────────
// `amount` bleibt IMMER der EUR-Wert (Bilanz). Die folgenden Felder sind reine
// Herkunfts-/Anzeige-Info. original_currency = null → EUR nativ.
//
// Normalisierung: leerer String / "EUR" / undefined → null (kein Fremd-Kontext).
const CurrencyCode = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" && v !== "EUR" ? v.trim() : null),
  z.union([z.null(), z.string().refine(isSupportedCurrency, "Nicht unterstützte Währung.")]),
);
const ExchangeRate = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v == null ? null : v;
    const s = v.trim();
    // Kurs NICHT über safeMathEval (das rundet auf 2 Nachkommastellen und
    // würde kleine Kurse wie 0,0903 zerstören) — nur Komma→Punkt.
    return s === "" ? null : s.replace(",", ".");
  },
  z.union([z.null(), z.coerce.number().positive("Kurs muss > 0 sein.").max(10_000_000)]),
);
const RateSource = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v : null),
  z.union([z.null(), z.enum(["live", "manual", "bank"])]),
);
// Optionaler Geldbetrag (darf ein Rechen-Ausdruck sein) — genutzt für den
// tatsächlich abgebuchten Euro-Betrag laut Kontoauszug UND den vollen
// Fremdbetrag der Kartenzahlung. null, wenn leer/nicht gesetzt.
const OptionalMoney = z.preprocess(
  (v) => {
    if (v == null) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    return evalExpr(v);
  },
  z.union([z.null(), z.coerce.number().nonnegative("Betrag darf nicht negativ sein.").max(MAX_AMOUNT)]),
);

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

/**
 * Eintrag der Pro-Person-Beträge. JSON-Form: [{ person_id, amount }].
 * `amount` ist der eingegebene Betrag. Bei Fremdwährungs-Buchungen enthält er
 * den FREMDBETRAG der Person (vom Bon); der Server rechnet ihn zum
 * Buchungskurs in EUR um und legt den Fremdbetrag als original_amount ab.
 */
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
     * Optional: ordnet die Buchung einer Anzahlungstranche zu (Migration 0023).
     * Wenn gesetzt, landet die Buchung im Anzahlungspool statt in der Bordkasse.
     * Typischer Use-Case: Skipper bucht die Yachtanzahlung und ordnet sie der
     * passenden Tranche zu.
     */
    tranche_id: z.string().uuid().optional().nullable(),
    idempotency_key: Uuid.optional(),
    // Fremdwährung (Migration 0041). Bei Fremdwährung trägt `amount` (bzw. die
    // Pro-Person-Beträge) den FREMDBETRAG; der Server rechnet in EUR um und legt
    // die Herkunft ab (original_amount/exchange_rate serverseitig). Bei EUR null.
    original_currency: CurrencyCode.default(null),
    exchange_rate: ExchangeRate.default(null),
    rate_source: RateSource.default(null),
    // Tatsächlich abgebuchter Euro-Betrag laut Kontoauszug (nachträglich, optional).
    // Wenn gesetzt (nur bei Fremdwährung sinnvoll), leitet der Server daraus den
    // effektiven Kurs ab und markiert rate_source='bank'. `bank_foreign_amount` =
    // voller Fremdbetrag der Kartenzahlung; nur nötig, wenn er vom Buchungsbetrag
    // abweicht (z. B. Privatkauf wurde rausgerechnet), sonst fällt der Server auf
    // den Buchungsbetrag zurück.
    bank_eur_amount: OptionalMoney.default(null),
    bank_foreign_amount: OptionalMoney.default(null),
  })
  .refine(
    (d) => d.split_type === "per_person" || d.amount > 0,
    { message: "Betrag muss > 0 sein.", path: ["amount"] },
  )
  .refine(
    (d) =>
      d.original_currency == null ||
      (d.exchange_rate != null && d.exchange_rate > 0) ||
      (d.bank_eur_amount != null && d.bank_eur_amount > 0),
    { message: "Für die Fremdwährung fehlt ein gültiger Wechselkurs.", path: ["exchange_rate"] },
  )
  .refine((d) => d.alcohol_amount <= d.amount, {
    message: "Alkoholanteil darf nicht größer als Gesamtbetrag sein.",
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
    // Fremdwährung (Migration 0041) — siehe ExpenseSchema.
    original_currency: CurrencyCode.default(null),
    exchange_rate: ExchangeRate.default(null),
    rate_source: RateSource.default(null),
    bank_eur_amount: OptionalMoney.default(null),
    bank_foreign_amount: OptionalMoney.default(null),
  })
  .refine((d) => d.credit_to !== d.credit_from, {
    message: "Von und An können nicht dieselbe Person sein.",
    path: ["credit_to"],
  })
  .refine(
    (d) =>
      d.original_currency == null ||
      (d.exchange_rate != null && d.exchange_rate > 0) ||
      (d.bank_eur_amount != null && d.bank_eur_amount > 0),
    { message: "Für die Fremdwährung fehlt ein gültiger Wechselkurs.", path: ["exchange_rate"] },
  );

export type ExpenseInput = z.infer<typeof ExpenseSchema>;
export type CreditInput = z.infer<typeof CreditSchema>;
