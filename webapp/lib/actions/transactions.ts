"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import {
  isAdmin,
  requireMember,
  requireSkipperOrAdmin,
  requireSkipperAdminOrAdvancer,
} from "@/lib/auth/authz";
import {
  trancheBelongsToTrip,
  personsBelongToTrip,
  CROSS_TRIP_PERSON_MSG,
} from "@/lib/auth/cross-trip";
import { logAudit } from "@/lib/db/audit";
import { tripVocab } from "@/lib/trip-vocab";
import { round2 } from "@/lib/utils";
import { resolveExpenseCurrency, resolveCreditCurrency } from "@/lib/rates/resolve";
import { ExpenseSchema, CreditSchema } from "@/lib/validation/transaction-schema";

const TransactionId = z.string().uuid();

export type TxState =
  | { status: "idle" }
  | { status: "ok" }
  | {
      status: "error";
      message: string;
      field?: string;
      /** Pro-Feld-Fehlermeldungen (Feldname → Text), damit das Formular sie
       *  direkt unter dem betroffenen Feld zeigen kann statt nur gesammelt. */
      fieldErrors?: Record<string, string>;
    };

/**
 * Baut aus einem ZodError eine Fehler-TxState mit allen Feld-Fehlern (erster
 * Fehler pro Feld). `message`/`field` bleiben für die generische Anzeige +
 * Fokus-Scroll erhalten.
 */
function zodErrorState(error: z.ZodError): TxState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0]?.toString();
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  const first = error.issues[0];
  return {
    status: "error",
    message: first?.message ?? "Ungültige Eingabe.",
    field: first?.path?.[0]?.toString(),
    fieldErrors,
  };
}

// Postgres-Fehlercode für UNIQUE-Verletzung — siehe
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = "23505";

// Eine Buchung einer Anzahlungstranche zuzuordnen (= Anzahlungspool) ist
// dieselbe Rolle vorbehalten, der das UI das Tranche-Feld überhaupt zeigt:
// Skipper / Admin / Vorstrecker. Da Server Actions mit dem Service-Role-Client
// schreiben (RLS umgangen), muss dieser Rollen-Check im App-Layer passieren.
const TRANCHE_AUTHZ_MSG =
  "Nur Skipper, Admin oder die vorstreckende Person dürfen eine Buchung einer Anzahlungstranche zuordnen.";

/**
 * Validiert, dass der Anteil pro Beteiligter mindestens 1 Cent ergibt.
 * Per-Person ist bereits durch das Zod-Refine abgesichert. Für die anderen
 * Splits brauchen wir die Crew-Größe vom Trip.
 */
async function checkMinShare(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
  data: {
    amount: number;
    split_type: "equal" | "on_board" | "time_proportional" | "individual" | "per_person";
    participant_ids: string[];
  },
): Promise<{ ok: true } | { ok: false; message: string; field: string }> {
  if (data.split_type === "per_person") return { ok: true };
  let nActive: number;
  if (data.split_type === "individual") {
    nActive = data.participant_ids.length;
  } else {
    const { count } = await supabase
      .from("trip_members")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", tripId);
    nActive = count ?? 0;
  }
  if (nActive < 1) return { ok: true }; // keine Crew — andere Validierungen fangen das ab
  if (data.amount / nActive < 0.01) {
    return {
      ok: false,
      message: `Anteil pro Person wäre unter 1 Cent (${nActive} Beteiligte). Bitte Betrag erhöhen oder weniger Personen.`,
      field: "amount",
    };
  }
  return { ok: true };
}

/**
 * „An Bord" verteilt auf die am Buchungstag Anwesenden — außerhalb des
 * Törnzeitraums ist das niemand und die Ausgabe bliebe unallokiert beim
 * Zahler hängen (keine Shares in v_transaction_shares, Bilanz-Summe ≠ 0).
 * Alle anderen Aufteilungen sind datumsunabhängig; Buchungen vor/nach dem
 * Törn (Anzahlung, Versicherung, Nachzügler-Rechnung) sind dort erlaubt.
 */
async function checkOnBoardDate(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
  data: {
    date: string;
    split_type: "equal" | "on_board" | "time_proportional" | "individual" | "per_person";
  },
): Promise<{ ok: true } | { ok: false; message: string; field: string }> {
  if (data.split_type !== "on_board") return { ok: true };
  const { data: trip } = await supabase
    .from("trips")
    .select("start_date, end_date, trip_type")
    .eq("id", tripId)
    .single();
  // Trip-Existenz sichert requireMember ab; ohne Daten lieber durchlassen
  // als eine valide Buchung zu blockieren.
  if (!trip) return { ok: true };
  if (data.date < trip.start_date || data.date > trip.end_date) {
    // Wording folgt dem Reise-Typ: bei „Andere Reise" heißt die Aufteilung
    // im UI „Anwesend" statt „An Bord" (tripVocab) — die Fehlermeldung muss
    // denselben Begriff verwenden, sonst findet die Person den Tab nicht.
    const vocab = tripVocab(trip.trip_type === "other" ? "other" : "sailing");
    const nobody = trip.trip_type === "other" ? "niemand anwesend" : "niemand an Bord";
    return {
      ok: false,
      field: "date",
      message: `Am gewählten Datum ist ${nobody} — „${vocab.onBoard}“ braucht ein Datum im ${vocab.trip}zeitraum. Bitte Datum anpassen oder eine andere Aufteilung (z. B. Gleichmäßig) wählen.`,
    };
  }
  return { ok: true };
}

// Cross-Trip-Schutz (trancheBelongsToTrip / personsBelongToTrip /
// CROSS_TRIP_PERSON_MSG) liegt in @/lib/auth/cross-trip — geteilt mit
// lib/actions/prepayments.ts, damit beide Schreibpfade dieselbe Invariante
// erzwingen.

/**
 * Generisches deutsches Fallback für unbehandelte PostgREST-/Postgres-Fehler.
 * Der Original-Fehler wird in der Server-Konsole geloggt; die Crew sieht eine
 * neutrale Meldung statt englischer DB-Internals.
 */
function dbErrorMessage(error: { message: string } | null, fallback: string): string {
  if (error?.message) console.error("[bordkasse:db]", error.message);
  return fallback;
}

/**
 * Setzt `trips.changes_pending_since` auf NOW, falls die Abrechnung schon
 * verschickt wurde und noch kein offener Änderungs-Hinweis vorliegt. So
 * sieht der Skipper auf der Trip-Übersicht den "Bilanz hat sich geändert"-
 * Banner und kann eine Update-Mail nachschieben.
 *
 * Fire-and-forget: Fehler werden geloggt aber bremsen die Haupt-Action nicht.
 */
async function markPostSettlementChange(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
): Promise<void> {
  const { error } = await supabase.rpc("mark_post_settlement_change", { p_trip_id: tripId });
  if (error) console.error("[bordkasse:settlement-resend]", error.message);
}

/**
 * Hat sich an einer Buchung etwas geändert, das die **Bilanz** beeinflusst?
 *
 * Reine Umbenennung (`description`) oder Umkategorisierung (`category_id`)
 * verschieben keinen einzigen Cent zwischen Personen — dafür soll der
 * "Bilanz hat sich seit der Abrechnung geändert"-Banner NICHT erscheinen.
 * Beide Felder werden hier bewusst NICHT verglichen.
 */
function participantSignature(
  parts: { person_id: string; amount: number | null }[],
): string {
  return parts
    .map((p) => `${p.person_id}:${p.amount == null ? "" : round2(p.amount)}`)
    .sort()
    .join("|");
}

interface ExpenseBalanceFields {
  date: string;
  paid_by: string;
  amount: number;
  alcohol_amount: number;
  tip_amount: number;
  tip_distribution: string;
  split_type: string;
  tranche_id: string | null;
  participants: { person_id: string; amount: number | null }[];
}

/**
 * Bilanz-relevant bei Ausgaben: Datum (steuert "An Bord"), Bezahler, Betrag,
 * Alkohol-/Trinkgeld-Anteil, Trinkgeld-Verteilung, Aufteilungsart,
 * Tranchen-Zuordnung (Pool ↔ Bordkasse) und die Beteiligten samt Anteilen.
 */
function expenseBalanceChanged(before: ExpenseBalanceFields, after: ExpenseBalanceFields): boolean {
  return (
    before.date !== after.date ||
    before.paid_by !== after.paid_by ||
    round2(before.amount) !== round2(after.amount) ||
    round2(before.alcohol_amount) !== round2(after.alcohol_amount) ||
    round2(before.tip_amount) !== round2(after.tip_amount) ||
    before.tip_distribution !== after.tip_distribution ||
    before.split_type !== after.split_type ||
    (before.tranche_id ?? null) !== (after.tranche_id ?? null) ||
    participantSignature(before.participants) !== participantSignature(after.participants)
  );
}

interface CreditBalanceFields {
  amount: number;
  credit_from: string;
  credit_to: string | null;
  tranche_id: string | null;
}

/**
 * Bilanz-relevant bei Gutschriften: Betrag, Von/An und Tranchen-Zuordnung.
 * Das Datum ist bei Gutschriften rein informativ (keine datumsabhängige
 * Aufteilung) und zählt daher NICHT.
 */
function creditBalanceChanged(before: CreditBalanceFields, after: CreditBalanceFields): boolean {
  return (
    round2(before.amount) !== round2(after.amount) ||
    before.credit_from !== after.credit_from ||
    (before.credit_to ?? null) !== (after.credit_to ?? null) ||
    (before.tranche_id ?? null) !== (after.tranche_id ?? null)
  );
}

/** Neue Beteiligten-Signatur einer Ausgabe aus den Formularwerten. */
function newExpenseParticipants(
  splitType: string,
  participantIds: string[],
  participantAmounts: { person_id: string; amount: number }[],
): { person_id: string; amount: number | null }[] {
  if (splitType === "individual") {
    return participantIds.map((id) => ({ person_id: id, amount: null }));
  }
  if (splitType === "per_person") {
    return participantAmounts
      .filter((p) => p.amount > 0)
      .map((p) => ({ person_id: p.person_id, amount: p.amount }));
  }
  return [];
}

// Fremdwährungs-Umrechnung (resolveExpenseCurrency / resolveCreditCurrency)
// liegt in @/lib/rates/resolve — pure Funktionen, unit-getestet. EUR bleibt
// die einzige Bilanz-Wahrheit; die Herkunft (original_*/exchange_rate/
// rate_source) wird dort abgeleitet, inkl. Bank-Override (rate_source='bank').

/** Zeitstempel der Bankkurs-Bestätigung: gesetzt, sobald der tatsächliche
 *  Bankbetrag nachgetragen wurde (rate_source='bank'), sonst null. */
function rateConfirmedAt(source: string | null): string | null {
  return source === "bank" ? new Date().toISOString() : null;
}

export async function createExpense(_prev: TxState, formData: FormData): Promise<TxState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const participantIds = formData.getAll("participant_ids").map(String).filter(Boolean);

  const parsed = ExpenseSchema.safeParse({
    trip_id: formData.get("trip_id"),
    date: formData.get("date"),
    description: formData.get("description"),
    category_id: formData.get("category_id") || null,
    paid_by: formData.get("paid_by"),
    amount: formData.get("amount"),
    alcohol_amount: formData.get("alcohol_amount") || 0,
    tip_amount: formData.get("tip_amount") || 0,
    tip_distribution: formData.get("tip_distribution") || "proportional",
    split_type: formData.get("split_type"),
    participant_ids: participantIds,
    participant_amounts: formData.get("participant_amounts"),
    tranche_id: formData.get("tranche_id") || null,
    idempotency_key: formData.get("idempotency_key") || undefined,
    original_currency: formData.get("original_currency"),
    exchange_rate: formData.get("exchange_rate"),
    rate_source: formData.get("rate_source"),
    bank_eur_amount: formData.get("bank_eur_amount"),
    bank_foreign_amount: formData.get("bank_foreign_amount"),
  });
  if (!parsed.success) {
    return zodErrorState(parsed.error);
  }

  const { participant_ids, participant_amounts, idempotency_key, tranche_id: trancheId,
    original_currency, exchange_rate, rate_source, bank_eur_amount, bank_foreign_amount, ...txData } = parsed.data;

  // Fremdwährung → EUR umrechnen + Herkunft ableiten. Bei "Pro Person" wird der
  // Gesamtbetrag aus den Einzelbeträgen abgeleitet (Anzeige/DB konsistent),
  // Trinkgeld nur dort sinnvoll, sonst 0. EUR ist die Bilanz-Wahrheit.
  const cur = resolveExpenseCurrency({
    split_type: txData.split_type,
    amount: txData.amount,
    alcohol_amount: txData.alcohol_amount,
    tip_amount: txData.tip_amount,
    original_currency,
    exchange_rate,
    rate_source,
    bank_eur_amount,
    bank_foreign_amount,
    participant_amounts,
  });
  txData.amount = cur.amount;
  txData.alcohol_amount = cur.alcohol_amount;
  txData.tip_amount = cur.tip_amount;

  const memberCheck = await requireMember(txData.trip_id);
  if (!memberCheck.ok) return { status: "error", message: memberCheck.message };

  const supabase = createAdminClient();

  // Min-1-Cent-pro-Person-Check vor dem Insert.
  const minCheck = await checkMinShare(supabase, txData.trip_id, {
    amount: txData.amount,
    split_type: txData.split_type,
    participant_ids,
  });
  if (!minCheck.ok) return { status: "error", message: minCheck.message, field: minCheck.field };

  const dateCheck = await checkOnBoardDate(supabase, txData.trip_id, txData);
  if (!dateCheck.ok) return { status: "error", message: dateCheck.message, field: dateCheck.field };

  if (!(await trancheBelongsToTrip(supabase, trancheId, txData.trip_id))) {
    return { status: "error", message: "Ungültige Tranche für diesen Törn." };
  }

  // Eine Tranche zuzuordnen ist Skipper/Admin/Vorstrecker vorbehalten — das
  // bloße `requireMember` oben genügt nur für gewöhnliche Bordkasse-Buchungen.
  // So kann kein normales Crewmitglied (das das UI-Feld gar nicht sieht) per
  // manipuliertem Request eine Ausgabe in den Anzahlungspool schieben.
  if (trancheId) {
    const trancheAuth = await requireSkipperAdminOrAdvancer(txData.trip_id);
    if (!trancheAuth.ok) return { status: "error", message: TRANCHE_AUTHZ_MSG };
  }

  if (
    !(await personsBelongToTrip(
      supabase,
      [txData.paid_by, ...participant_ids, ...participant_amounts.map((p) => p.person_id)],
      txData.trip_id,
    ))
  ) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      ...txData,
      type: "expense",
      created_by: person.id,
      idempotency_key,
      tranche_id: trancheId ?? null,
      original_currency: cur.original_currency,
      original_amount: cur.original_amount,
      exchange_rate: cur.exchange_rate,
      rate_source: cur.rate_source,
      rate_confirmed_at: rateConfirmedAt(cur.rate_source),
    })
    .select("id")
    .single();

  if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
    // Retry des Clients — Buchung ist schon angelegt, wir leiten einfach weiter.
    revalidatePath(`/trips/${txData.trip_id}/transactions`);
    redirect(`/trips/${txData.trip_id}/transactions?toast=expense-created`);
  }
  if (error || !tx) {
    return { status: "error", message: dbErrorMessage(error, "Buchung konnte nicht angelegt werden. Bitte erneut versuchen.") };
  }

  const partRes =
    txData.split_type === "individual" && participant_ids.length > 0
      ? await supabase
          .from("transaction_participants")
          .insert(participant_ids.map((pid) => ({ transaction_id: tx.id, person_id: pid })))
      : txData.split_type === "per_person" && cur.perPerson.length > 0
        ? await supabase
            .from("transaction_participants")
            .insert(
              cur.perPerson.map((p) => ({
                transaction_id: tx.id,
                person_id: p.person_id,
                amount: p.amount,
                original_amount: p.original_amount,
              })),
            )
        : null;
  if (partRes?.error) {
    // Anteile konnten nicht geschrieben werden → die Buchung wäre falsch
    // aufgeteilt. Rollback der gerade erzeugten Buchung (gibt den
    // idempotency_key wieder frei → Retry erzeugt eine saubere Buchung)
    // statt stillem "Erfolg" mit fehlenden Anteilen.
    await supabase.from("transactions").delete().eq("id", tx.id);
    return {
      status: "error",
      message: dbErrorMessage(partRes.error, "Buchung konnte nicht vollständig gespeichert werden. Bitte erneut versuchen."),
    };
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: txData.trip_id,
    actor_person_id: person.id,
    payload: { type: "expense", ...txData, participant_ids, participant_amounts },
  });

  await markPostSettlementChange(supabase, txData.trip_id);
  revalidatePath(`/trips/${txData.trip_id}/transactions`);
  revalidatePath(`/trips/${txData.trip_id}/balance`);
  revalidatePath(`/trips/${txData.trip_id}/debts`);
  redirect(`/trips/${txData.trip_id}/transactions?toast=expense-created`);
}

export async function createCredit(_prev: TxState, formData: FormData): Promise<TxState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const creditToRaw = formData.get("credit_to")?.toString() ?? "";
  const creditTo = creditToRaw === "ALL" ? null : creditToRaw;

  const parsed = CreditSchema.safeParse({
    trip_id: formData.get("trip_id"),
    date: formData.get("date"),
    description: formData.get("description") || "",
    amount: formData.get("amount"),
    credit_from: formData.get("credit_from"),
    credit_to: creditTo,
    tranche_id: formData.get("tranche_id") || null,
    idempotency_key: formData.get("idempotency_key") || undefined,
    original_currency: formData.get("original_currency"),
    exchange_rate: formData.get("exchange_rate"),
    rate_source: formData.get("rate_source"),
    bank_eur_amount: formData.get("bank_eur_amount"),
    bank_foreign_amount: formData.get("bank_foreign_amount"),
  });
  if (!parsed.success) {
    return zodErrorState(parsed.error);
  }

  const skipperCheck = await requireSkipperOrAdmin(parsed.data.trip_id);
  if (!skipperCheck.ok) return { status: "error", message: skipperCheck.message };

  const supabase = createAdminClient();

  // „An Alle" (credit_to IS NULL) braucht ≥ 2 Crewmitglieder, sonst kann
  // die Bilanz nicht ausgeglichen werden (creditFrom bekommt +amount, aber
  // niemand bekommt es gegengebucht).
  if (parsed.data.credit_to == null) {
    const { count } = await supabase
      .from("trip_members")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", parsed.data.trip_id);
    if ((count ?? 0) <= 1) {
      return {
        status: "error",
        message: '„An Alle"-Gutschriften brauchen mindestens 2 Crewmitglieder. Wähle, wer das Geld bekommt.',
        field: "credit_to",
      };
    }
  }

  if (!(await trancheBelongsToTrip(supabase, parsed.data.tranche_id, parsed.data.trip_id))) {
    return { status: "error", message: "Ungültige Tranche für diesen Törn." };
  }

  if (
    !(await personsBelongToTrip(
      supabase,
      [parsed.data.credit_from, parsed.data.credit_to],
      parsed.data.trip_id,
    ))
  ) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  const creditCur = resolveCreditCurrency({
    amount: parsed.data.amount,
    original_currency: parsed.data.original_currency,
    exchange_rate: parsed.data.exchange_rate,
    rate_source: parsed.data.rate_source,
    bank_eur_amount: parsed.data.bank_eur_amount,
    bank_foreign_amount: parsed.data.bank_foreign_amount,
  });

  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: parsed.data.trip_id,
      type: "credit",
      date: parsed.data.date,
      description: parsed.data.description || "Gutschrift",
      amount: creditCur.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      tranche_id: parsed.data.tranche_id ?? null,
      created_by: person.id,
      idempotency_key: parsed.data.idempotency_key,
      original_currency: creditCur.original_currency,
      original_amount: creditCur.original_amount,
      exchange_rate: creditCur.exchange_rate,
      rate_source: creditCur.rate_source,
      rate_confirmed_at: rateConfirmedAt(creditCur.rate_source),
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && parsed.data.idempotency_key) {
    revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
    redirect(`/trips/${parsed.data.trip_id}/transactions?toast=credit-created`);
  }
  if (error || !tx) return { status: "error", message: dbErrorMessage(error, "Gutschrift konnte nicht angelegt werden. Bitte erneut versuchen.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: parsed.data.trip_id,
    actor_person_id: person.id,
    payload: { type: "credit", ...parsed.data },
  });

  await markPostSettlementChange(supabase, parsed.data.trip_id);
  revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
  revalidatePath(`/trips/${parsed.data.trip_id}/balance`);
  revalidatePath(`/trips/${parsed.data.trip_id}/debts`);
  redirect(`/trips/${parsed.data.trip_id}/transactions?toast=credit-created`);
}

/**
 * Berechtigung zum Editieren / Löschen einer Transaktion: entweder Skipper
 * oder Admin des Trips, oder die Person, die die Buchung erstellt hat.
 */
async function canEditTransaction(
  tripId: string,
  createdBy: string | null,
  currentPersonId: string,
): Promise<boolean> {
  if (createdBy && createdBy === currentPersonId) return true;
  const skipperCheck = await requireSkipperOrAdmin(tripId);
  if (skipperCheck.ok) return true;
  return await isAdmin();
}

export async function updateExpense(_prev: TxState, formData: FormData): Promise<TxState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const txIdParse = TransactionId.safeParse(formData.get("transaction_id"));
  if (!txIdParse.success) return { status: "error", message: "Ungültige Buchungs-ID." };
  const transactionId = txIdParse.data;

  const participantIds = formData.getAll("participant_ids").map(String).filter(Boolean);
  const parsed = ExpenseSchema.safeParse({
    trip_id: formData.get("trip_id"),
    date: formData.get("date"),
    description: formData.get("description"),
    category_id: formData.get("category_id") || null,
    paid_by: formData.get("paid_by"),
    amount: formData.get("amount"),
    alcohol_amount: formData.get("alcohol_amount") || 0,
    tip_amount: formData.get("tip_amount") || 0,
    tip_distribution: formData.get("tip_distribution") || "proportional",
    split_type: formData.get("split_type"),
    participant_ids: participantIds,
    participant_amounts: formData.get("participant_amounts"),
    tranche_id: formData.get("tranche_id") || null,
    original_currency: formData.get("original_currency"),
    exchange_rate: formData.get("exchange_rate"),
    rate_source: formData.get("rate_source"),
    bank_eur_amount: formData.get("bank_eur_amount"),
    bank_foreign_amount: formData.get("bank_foreign_amount"),
  });
  if (!parsed.success) {
    return zodErrorState(parsed.error);
  }
  const { participant_ids, participant_amounts, idempotency_key: _ignored, tranche_id: trancheId,
    original_currency, exchange_rate, rate_source, bank_eur_amount, bank_foreign_amount, ...txData } = parsed.data;
  void _ignored;

  const cur = resolveExpenseCurrency({
    split_type: txData.split_type,
    amount: txData.amount,
    alcohol_amount: txData.alcohol_amount,
    tip_amount: txData.tip_amount,
    original_currency,
    exchange_rate,
    rate_source,
    bank_eur_amount,
    bank_foreign_amount,
    participant_amounts,
  });
  txData.amount = cur.amount;
  txData.alcohol_amount = cur.alcohol_amount;
  txData.tip_amount = cur.tip_amount;

  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("transactions")
    .select(
      "created_by, type, trip_id, deleted_at, category_id, date, paid_by, amount, alcohol_amount, tip_amount, tip_distribution, split_type, tranche_id",
    )
    .eq("id", transactionId)
    .maybeSingle();
  if (!existing || existing.deleted_at) return { status: "error", message: "Buchung nicht gefunden." };
  if (existing.trip_id !== txData.trip_id) {
    return { status: "error", message: "Buchung gehört nicht zu diesem Törn." };
  }
  if (existing.type !== "expense") {
    return { status: "error", message: "Diese Buchung ist keine Ausgabe." };
  }

  // Beteiligte VOR dem Neuschreiben laden — für den Bilanz-Diff (s. u.).
  const { data: existingParts } = await supabase
    .from("transaction_participants")
    .select("person_id, amount")
    .eq("transaction_id", transactionId);
  if (!(await canEditTransaction(txData.trip_id, existing.created_by, person.id))) {
    return { status: "error", message: "Nur Skipper, Admin oder die Person, die gebucht hat, dürfen ändern." };
  }

  // Wurde eine Kaution-Buchung berührt? (alte oder neue Kategorie = "Kaution")
  // Dann nach dem Speichern den Skipper an die Abrechnung erinnern.
  const touchedKaution = await isKautionCategory(
    supabase,
    txData.trip_id,
    existing.category_id,
    txData.category_id,
  );

  // Min-1-Cent-pro-Person-Check vor dem Update.
  const minCheck = await checkMinShare(supabase, txData.trip_id, {
    amount: txData.amount,
    split_type: txData.split_type,
    participant_ids,
  });
  if (!minCheck.ok) return { status: "error", message: minCheck.message, field: minCheck.field };

  const dateCheck = await checkOnBoardDate(supabase, txData.trip_id, txData);
  if (!dateCheck.ok) return { status: "error", message: dateCheck.message, field: dateCheck.field };

  // Tranche-Zuordnung darf nur ändern, wer das Feld auch sieht
  // (Skipper/Admin/Vorstrecker). Andere Editoren — z.B. der Ersteller einer
  // gewöhnlichen Ausgabe — bekommen das Feld nicht gerendert; für sie bleibt
  // die bestehende Zuordnung unverändert, statt sie über das fehlende
  // Input-Feld (tranche_id = null) versehentlich aus dem Anzahlungspool zu
  // lösen. Der `tranche_field_present`-Marker unterscheidet „Feld da, bewusst
  // auf Keine gesetzt" von „Feld gar nicht angezeigt".
  const trancheFieldPresent = formData.get("tranche_field_present") === "1";
  let trancheToSave: string | null = existing.tranche_id ?? null;
  if (trancheFieldPresent && (trancheId ?? null) !== (existing.tranche_id ?? null)) {
    const trancheAuth = await requireSkipperAdminOrAdvancer(txData.trip_id);
    if (!trancheAuth.ok) return { status: "error", message: TRANCHE_AUTHZ_MSG };
    if (!(await trancheBelongsToTrip(supabase, trancheId, txData.trip_id))) {
      return { status: "error", message: "Ungültige Tranche für diesen Törn." };
    }
    trancheToSave = trancheId ?? null;
  }

  if (
    !(await personsBelongToTrip(
      supabase,
      [txData.paid_by, ...participant_ids, ...participant_amounts.map((p) => p.person_id)],
      txData.trip_id,
    ))
  ) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  const { error } = await supabase
    .from("transactions")
    .update({
      date: txData.date,
      description: txData.description,
      category_id: txData.category_id,
      paid_by: txData.paid_by,
      amount: txData.amount,
      alcohol_amount: txData.alcohol_amount,
      tip_amount: txData.tip_amount,
      tip_distribution: txData.tip_distribution,
      split_type: txData.split_type,
      tranche_id: trancheToSave,
      original_currency: cur.original_currency,
      original_amount: cur.original_amount,
      exchange_rate: cur.exchange_rate,
      rate_source: cur.rate_source,
      rate_confirmed_at: rateConfirmedAt(cur.rate_source),
    })
    .eq("id", transactionId)
    .eq("trip_id", txData.trip_id);
  if (error) return { status: "error", message: dbErrorMessage(error, "Speichern fehlgeschlagen. Bitte erneut versuchen.") };

  // Participants neu setzen — bei Wechsel der Aufteilung müssen alte raus.
  const delRes = await supabase
    .from("transaction_participants")
    .delete()
    .eq("transaction_id", transactionId);
  if (delRes.error) {
    return {
      status: "error",
      message: dbErrorMessage(delRes.error, "Speichern fehlgeschlagen. Bitte erneut versuchen."),
    };
  }
  const partRes =
    txData.split_type === "individual" && participant_ids.length > 0
      ? await supabase
          .from("transaction_participants")
          .insert(participant_ids.map((pid) => ({ transaction_id: transactionId, person_id: pid })))
      : txData.split_type === "per_person" && cur.perPerson.length > 0
        ? await supabase
            .from("transaction_participants")
            .insert(
              cur.perPerson.map((p) => ({
                transaction_id: transactionId,
                person_id: p.person_id,
                amount: p.amount,
                original_amount: p.original_amount,
              })),
            )
        : null;
  if (partRes?.error) {
    return {
      status: "error",
      message: dbErrorMessage(partRes.error, "Speichern fehlgeschlagen — die Aufteilung konnte nicht aktualisiert werden. Bitte erneut versuchen."),
    };
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "UPDATE",
    record_id: transactionId,
    trip_id: txData.trip_id,
    actor_person_id: person.id,
    payload: { type: "expense", ...txData, participant_ids, participant_amounts },
  });

  // Banner nur, wenn sich tatsächlich die Bilanz ändert — reine Umbenennung
  // oder Umkategorisierung soll keine Update-Mail-Aufforderung auslösen.
  const balanceChanged = expenseBalanceChanged(
    {
      date: existing.date,
      paid_by: existing.paid_by,
      amount: existing.amount,
      alcohol_amount: existing.alcohol_amount ?? 0,
      tip_amount: existing.tip_amount ?? 0,
      tip_distribution: existing.tip_distribution ?? "proportional",
      split_type: existing.split_type,
      tranche_id: existing.tranche_id,
      participants: existingParts ?? [],
    },
    {
      date: txData.date,
      paid_by: txData.paid_by,
      amount: txData.amount,
      alcohol_amount: txData.alcohol_amount,
      tip_amount: txData.tip_amount,
      tip_distribution: txData.tip_distribution,
      split_type: txData.split_type,
      tranche_id: trancheToSave,
      // EUR-Anteile (nicht die Fremdbeträge) vergleichen — sonst gälte eine
      // Fremdwährungs-Buchung immer als „geändert".
      participants: newExpenseParticipants(txData.split_type, participant_ids, cur.perPerson),
    },
  );
  if (balanceChanged) await markPostSettlementChange(supabase, txData.trip_id);
  revalidatePath(`/trips/${txData.trip_id}/transactions`);
  revalidatePath(`/trips/${txData.trip_id}/balance`);
  revalidatePath(`/trips/${txData.trip_id}/debts`);
  // Bei Kaution-Buchungs-Edit: zurück zur Trip-Übersicht mit Settlement-Hinweis,
  // damit der Skipper nicht vergisst die Abrechnung zu starten. Der toast-Param
  // sorgt dafür, dass die Erfolgs-Rückmeldung trotz Redirect nicht verloren geht.
  if (touchedKaution) {
    redirect(`/trips/${txData.trip_id}?check_settlement=1&toast=expense-updated`);
  }
  redirect(`/trips/${txData.trip_id}/transactions?toast=expense-updated`);
}

/**
 * Prüft, ob eine der angegebenen category_ids zur "Kaution"-Default-Kategorie
 * gehört. Wir matchen am Kategorie-Namen (statt einer harten ID), weil jeder
 * Trip seine eigenen Kategorie-Rows hat. Custom-Namen mit "Kaution" zählen
 * auch (z. B. "Kautionsschaden"), um false-negatives bei umbenannten
 * Default-Kategorien zu vermeiden.
 */
async function isKautionCategory(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
  ...categoryIds: Array<string | null | undefined>
): Promise<boolean> {
  const ids = categoryIds.filter((id): id is string => !!id);
  if (ids.length === 0) return false;
  const { data } = await supabase
    .from("trip_categories")
    .select("name")
    .eq("trip_id", tripId)
    .in("id", ids);
  return (data ?? []).some((c) => /kaution/i.test(c.name ?? ""));
}

export async function updateCredit(_prev: TxState, formData: FormData): Promise<TxState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const txIdParse = TransactionId.safeParse(formData.get("transaction_id"));
  if (!txIdParse.success) return { status: "error", message: "Ungültige Buchungs-ID." };
  const transactionId = txIdParse.data;

  const creditToRaw = formData.get("credit_to")?.toString() ?? "";
  const creditTo = creditToRaw === "ALL" ? null : creditToRaw;

  const parsed = CreditSchema.safeParse({
    trip_id: formData.get("trip_id"),
    date: formData.get("date"),
    description: formData.get("description") || "",
    amount: formData.get("amount"),
    credit_from: formData.get("credit_from"),
    credit_to: creditTo,
    tranche_id: formData.get("tranche_id") || null,
    original_currency: formData.get("original_currency"),
    exchange_rate: formData.get("exchange_rate"),
    rate_source: formData.get("rate_source"),
    bank_eur_amount: formData.get("bank_eur_amount"),
    bank_foreign_amount: formData.get("bank_foreign_amount"),
  });
  if (!parsed.success) {
    return zodErrorState(parsed.error);
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("transactions")
    .select("created_by, type, trip_id, deleted_at, amount, credit_from, credit_to, tranche_id")
    .eq("id", transactionId)
    .maybeSingle();
  if (!existing || existing.deleted_at) return { status: "error", message: "Buchung nicht gefunden." };
  if (existing.trip_id !== parsed.data.trip_id) {
    return { status: "error", message: "Buchung gehört nicht zu diesem Törn." };
  }
  if (existing.type !== "credit") {
    return { status: "error", message: "Diese Buchung ist keine Gutschrift." };
  }

  // Gutschriften ändern: weiterhin nur Skipper/Admin (oder Creator —
  // bei aktuellem Workflow ist das aber sowieso Skipper/Admin).
  if (!(await canEditTransaction(parsed.data.trip_id, existing.created_by, person.id))) {
    return { status: "error", message: "Nur Skipper, Admin oder die Person, die gebucht hat, dürfen ändern." };
  }

  // „An Alle"-Validierung wie bei createCredit
  if (parsed.data.credit_to == null) {
    const { count } = await supabase
      .from("trip_members")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", parsed.data.trip_id);
    if ((count ?? 0) <= 1) {
      return {
        status: "error",
        message: '„An Alle"-Gutschriften brauchen mindestens 2 Crewmitglieder. Wähle, wer das Geld bekommt.',
        field: "credit_to",
      };
    }
  }

  if (!(await trancheBelongsToTrip(supabase, parsed.data.tranche_id, parsed.data.trip_id))) {
    return { status: "error", message: "Ungültige Tranche für diesen Törn." };
  }

  if (
    !(await personsBelongToTrip(
      supabase,
      [parsed.data.credit_from, parsed.data.credit_to],
      parsed.data.trip_id,
    ))
  ) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  const creditCur = resolveCreditCurrency({
    amount: parsed.data.amount,
    original_currency: parsed.data.original_currency,
    exchange_rate: parsed.data.exchange_rate,
    rate_source: parsed.data.rate_source,
    bank_eur_amount: parsed.data.bank_eur_amount,
    bank_foreign_amount: parsed.data.bank_foreign_amount,
  });

  const { error } = await supabase
    .from("transactions")
    .update({
      date: parsed.data.date,
      description: parsed.data.description || "Gutschrift",
      amount: creditCur.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      tranche_id: parsed.data.tranche_id ?? null,
      original_currency: creditCur.original_currency,
      original_amount: creditCur.original_amount,
      exchange_rate: creditCur.exchange_rate,
      rate_source: creditCur.rate_source,
      rate_confirmed_at: rateConfirmedAt(creditCur.rate_source),
    })
    .eq("id", transactionId)
    .eq("trip_id", parsed.data.trip_id);
  if (error) return { status: "error", message: dbErrorMessage(error, "Speichern fehlgeschlagen. Bitte erneut versuchen.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "UPDATE",
    record_id: transactionId,
    trip_id: parsed.data.trip_id,
    actor_person_id: person.id,
    payload: { type: "credit", ...parsed.data },
  });

  // Banner nur bei echter Bilanz-Änderung (s. updateExpense) — reine
  // Umbenennung der Gutschrift soll keine Update-Mail-Aufforderung auslösen.
  const balanceChanged = creditBalanceChanged(
    {
      amount: existing.amount,
      credit_from: existing.credit_from,
      credit_to: existing.credit_to,
      tranche_id: existing.tranche_id,
    },
    {
      amount: creditCur.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      tranche_id: parsed.data.tranche_id ?? null,
    },
  );
  if (balanceChanged) await markPostSettlementChange(supabase, parsed.data.trip_id);
  revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
  revalidatePath(`/trips/${parsed.data.trip_id}/balance`);
  revalidatePath(`/trips/${parsed.data.trip_id}/debts`);
  redirect(`/trips/${parsed.data.trip_id}/transactions?toast=credit-updated`);
}

/**
 * Soft-Delete: setzt deleted_at-Timestamp statt zu löschen. Bilanz, Schulden
 * und Listen filtern deleted_at IS NULL und behandeln den Eintrag als weg —
 * physisch bleibt er aber erhalten und ist über das Audit-Log nachvollziehbar.
 *
 * Liefert `wasKaution=true` zurück, wenn die gelöschte Buchung eine
 * Kaution-Kategorie hatte — der Client kann dann zur Trip-Übersicht
 * navigieren und den Skipper an die Abrechnung erinnern.
 */
export async function deleteTransaction(
  transactionId: string,
  tripId: string,
): Promise<{ ok: boolean; wasKaution: boolean }> {
  const auth = await requireMember(tripId);
  if (!auth.ok) return { ok: false, wasKaution: false };
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("transactions")
    .select("category_id, trip_id")
    .eq("id", transactionId)
    .maybeSingle();
  // IDOR-Schutz: requireMember(tripId) prüft nur die Mitgliedschaft im
  // übergebenen Törn. Ohne diese Zugehörigkeits-Prüfung könnte ein Mitglied
  // von Törn A eine beliebige fremde transactionId (Törn B) löschen.
  if (!existing || existing.trip_id !== tripId) {
    return { ok: false, wasKaution: false };
  }
  const wasKaution = await isKautionCategory(supabase, tripId, existing.category_id);
  await supabase
    .from("transactions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", transactionId)
    .eq("trip_id", tripId);
  await logAudit(supabase, {
    table_name: "transactions",
    operation: "DELETE",
    record_id: transactionId,
    trip_id: tripId,
    actor_person_id: auth.personId,
  });
  await markPostSettlementChange(supabase, tripId);
  revalidatePath(`/trips/${tripId}/transactions`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
  return { ok: true, wasKaution };
}

/**
 * Replay einer offline erfassten Buchung von der Outbox aus.
 * Macht KEINEN Redirect — wird vom Client-Sync ohne Navigation aufgerufen.
 * Idempotency-Key verhindert Duplikate, falls dieselbe Buchung schon
 * in einer anderen Session synchronisiert wurde.
 */
export async function replayPendingTransaction(
  kind: "expense" | "credit",
  formObject: Record<string, string | string[]>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };

  const tripId = String(formObject.trip_id ?? "");
  if (!tripId) return { ok: false, message: "Ungültige Daten." };
  // Gutschriften nur Skipper/Admin, Ausgaben jeder Crew-Member.
  const authCheck = kind === "credit"
    ? await requireSkipperOrAdmin(tripId)
    : await requireMember(tripId);
  if (!authCheck.ok) return { ok: false, message: authCheck.message };

  const supabase = createAdminClient();

  if (kind === "expense") {
    const participantIds = (formObject.participant_ids as string[] | undefined) ?? [];
    const parsed = ExpenseSchema.safeParse({
      trip_id: formObject.trip_id,
      date: formObject.date,
      description: formObject.description,
      category_id: formObject.category_id || null,
      paid_by: formObject.paid_by,
      amount: formObject.amount,
      alcohol_amount: formObject.alcohol_amount || 0,
      tip_amount: formObject.tip_amount || 0,
      tip_distribution: formObject.tip_distribution || "proportional",
      split_type: formObject.split_type,
      participant_ids: participantIds,
      participant_amounts: formObject.participant_amounts,
      idempotency_key: formObject.idempotency_key || undefined,
      original_currency: formObject.original_currency,
      exchange_rate: formObject.exchange_rate,
      rate_source: formObject.rate_source,
      bank_eur_amount: formObject.bank_eur_amount,
      bank_foreign_amount: formObject.bank_foreign_amount,
    });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
    }
    const { participant_ids, participant_amounts, idempotency_key,
      original_currency, exchange_rate, rate_source, bank_eur_amount, bank_foreign_amount, ...txData } = parsed.data;

    const cur = resolveExpenseCurrency({
      split_type: txData.split_type,
      amount: txData.amount,
      alcohol_amount: txData.alcohol_amount,
      tip_amount: txData.tip_amount,
      original_currency,
      exchange_rate,
      rate_source,
      bank_eur_amount,
      bank_foreign_amount,
      participant_amounts,
    });
    txData.amount = cur.amount;
    txData.alcohol_amount = cur.alcohol_amount;
    txData.tip_amount = cur.tip_amount;

    const { data: tx, error } = await supabase
      .from("transactions")
      .insert({
        ...txData,
        type: "expense",
        created_by: person.id,
        idempotency_key,
        original_currency: cur.original_currency,
        original_amount: cur.original_amount,
        exchange_rate: cur.exchange_rate,
        rate_source: cur.rate_source,
        rate_confirmed_at: rateConfirmedAt(cur.rate_source),
      })
      .select("id")
      .single();
    if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
      revalidatePath(`/trips/${txData.trip_id}/transactions`);
      return { ok: true };
    }
    if (error || !tx) {
      return { ok: false, message: dbErrorMessage(error, "Serverfehler") };
    }
    const partRes =
      txData.split_type === "individual" && participant_ids.length > 0
        ? await supabase
            .from("transaction_participants")
            .insert(participant_ids.map((pid) => ({ transaction_id: tx.id, person_id: pid })))
        : txData.split_type === "per_person" && cur.perPerson.length > 0
          ? await supabase
              .from("transaction_participants")
              .insert(
                cur.perPerson.map((p) => ({
                  transaction_id: tx.id,
                  person_id: p.person_id,
                  amount: p.amount,
                  original_amount: p.original_amount,
                })),
              )
          : null;
    if (partRes?.error) {
      // Rollback: Buchung löschen, damit der idempotency_key frei wird und der
      // nächste Replay einen sauberen Versuch macht. Sonst griffe oben der
      // Unique-Violation-Kurzschluss und die Anteile fehlten dauerhaft.
      await supabase.from("transactions").delete().eq("id", tx.id);
      return { ok: false, message: dbErrorMessage(partRes.error, "Aufteilung fehlgeschlagen") };
    }
    await logAudit(supabase, {
      table_name: "transactions",
      operation: "INSERT",
      record_id: tx.id,
      trip_id: txData.trip_id,
      actor_person_id: person.id,
      payload: { type: "expense", source: "outbox-replay", ...txData, participant_ids, participant_amounts },
    });
    revalidatePath(`/trips/${txData.trip_id}/transactions`);
    revalidatePath(`/trips/${txData.trip_id}/balance`);
    revalidatePath(`/trips/${txData.trip_id}/debts`);
    return { ok: true };
  }

  // credit
  const creditToRaw = String(formObject.credit_to ?? "");
  const creditTo = creditToRaw === "ALL" || creditToRaw === "" ? null : creditToRaw;
  const parsed = CreditSchema.safeParse({
    trip_id: formObject.trip_id,
    date: formObject.date,
    description: formObject.description || "",
    amount: formObject.amount,
    credit_from: formObject.credit_from,
    credit_to: creditTo,
    idempotency_key: formObject.idempotency_key || undefined,
    original_currency: formObject.original_currency,
    exchange_rate: formObject.exchange_rate,
    rate_source: formObject.rate_source,
    bank_eur_amount: formObject.bank_eur_amount,
    bank_foreign_amount: formObject.bank_foreign_amount,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  // „An Alle"-Validierung wie in createCredit (siehe oben).
  if (parsed.data.credit_to == null) {
    const { count } = await supabase
      .from("trip_members")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", parsed.data.trip_id);
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        message: '„An Alle"-Gutschriften brauchen mindestens 2 Crewmitglieder.',
      };
    }
  }

  const creditCur = resolveCreditCurrency({
    amount: parsed.data.amount,
    original_currency: parsed.data.original_currency,
    exchange_rate: parsed.data.exchange_rate,
    rate_source: parsed.data.rate_source,
    bank_eur_amount: parsed.data.bank_eur_amount,
    bank_foreign_amount: parsed.data.bank_foreign_amount,
  });
  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: parsed.data.trip_id,
      type: "credit",
      date: parsed.data.date,
      description: parsed.data.description || "Gutschrift",
      amount: creditCur.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      created_by: person.id,
      idempotency_key: parsed.data.idempotency_key,
      original_currency: creditCur.original_currency,
      original_amount: creditCur.original_amount,
      exchange_rate: creditCur.exchange_rate,
      rate_source: creditCur.rate_source,
      rate_confirmed_at: rateConfirmedAt(creditCur.rate_source),
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && parsed.data.idempotency_key) {
    revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
    return { ok: true };
  }
  if (error || !tx) return { ok: false, message: dbErrorMessage(error, "Serverfehler") };
  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: parsed.data.trip_id,
    actor_person_id: person.id,
    payload: { type: "credit", source: "outbox-replay", ...parsed.data },
  });
  revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
  revalidatePath(`/trips/${parsed.data.trip_id}/balance`);
  revalidatePath(`/trips/${parsed.data.trip_id}/debts`);
  return { ok: true };
}
