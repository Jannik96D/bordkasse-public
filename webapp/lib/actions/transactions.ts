"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipper } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { ExpenseSchema, CreditSchema } from "@/lib/validation/transaction-schema";

export type TxState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string; field?: string };

// Postgres-Fehlercode für UNIQUE-Verletzung — siehe
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = "23505";

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
    split_type: formData.get("split_type"),
    participant_ids: participantIds,
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: "error", message: issue?.message ?? "Ungültige Eingabe.", field: issue?.path?.[0]?.toString() };
  }

  const { participant_ids, idempotency_key, ...txData } = parsed.data;

  const memberCheck = await requireMember(txData.trip_id);
  if (!memberCheck.ok) return { status: "error", message: memberCheck.message };

  const supabase = createAdminClient();
  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({ ...txData, type: "expense", created_by: person.id, idempotency_key })
    .select("id")
    .single();

  if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
    // Retry des Clients — Buchung ist schon angelegt, wir leiten einfach weiter.
    revalidatePath(`/trips/${txData.trip_id}/transactions`);
    redirect(`/trips/${txData.trip_id}/transactions`);
  }
  if (error || !tx) {
    return { status: "error", message: error?.message ?? "Buchung konnte nicht angelegt werden." };
  }

  if (txData.split_type === "individual" && participant_ids.length > 0) {
    await supabase
      .from("transaction_participants")
      .insert(participant_ids.map((pid) => ({ transaction_id: tx.id, person_id: pid })));
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: txData.trip_id,
    actor_person_id: person.id,
    payload: { type: "expense", ...txData, participant_ids },
  });

  revalidatePath(`/trips/${txData.trip_id}/transactions`);
  revalidatePath(`/trips/${txData.trip_id}/balance`);
  revalidatePath(`/trips/${txData.trip_id}/debts`);
  redirect(`/trips/${txData.trip_id}/transactions`);
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
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: "error", message: issue?.message ?? "Ungültige Eingabe.", field: issue?.path?.[0]?.toString() };
  }

  const skipperCheck = await requireSkipper(parsed.data.trip_id);
  if (!skipperCheck.ok) return { status: "error", message: skipperCheck.message };

  const supabase = createAdminClient();
  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: parsed.data.trip_id,
      type: "credit",
      date: parsed.data.date,
      description: parsed.data.description || "Gutschrift",
      amount: parsed.data.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      created_by: person.id,
      idempotency_key: parsed.data.idempotency_key,
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && parsed.data.idempotency_key) {
    revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
    redirect(`/trips/${parsed.data.trip_id}/transactions`);
  }
  if (error || !tx) return { status: "error", message: error?.message ?? "Buchung konnte nicht angelegt werden." };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: parsed.data.trip_id,
    actor_person_id: person.id,
    payload: { type: "credit", ...parsed.data },
  });

  revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
  revalidatePath(`/trips/${parsed.data.trip_id}/balance`);
  revalidatePath(`/trips/${parsed.data.trip_id}/debts`);
  redirect(`/trips/${parsed.data.trip_id}/transactions`);
}

/**
 * Soft-Delete: setzt deleted_at-Timestamp statt zu löschen. Bilanz, Schulden
 * und Listen filtern deleted_at IS NULL und behandeln den Eintrag als weg —
 * physisch bleibt er aber erhalten und ist über das Audit-Log nachvollziehbar.
 */
export async function deleteTransaction(transactionId: string, tripId: string) {
  const auth = await requireMember(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();
  await supabase
    .from("transactions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", transactionId);
  await logAudit(supabase, {
    table_name: "transactions",
    operation: "DELETE",
    record_id: transactionId,
    trip_id: tripId,
    actor_person_id: auth.personId,
  });
  revalidatePath(`/trips/${tripId}/transactions`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
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
  if (!tripId) return { ok: false, message: "trip_id fehlt." };
  // Gutschriften nur Skipper, Ausgaben jeder Crew-Member.
  const authCheck = kind === "credit"
    ? await requireSkipper(tripId)
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
      split_type: formObject.split_type,
      participant_ids: participantIds,
      idempotency_key: formObject.idempotency_key || undefined,
    });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
    }
    const { participant_ids, idempotency_key, ...txData } = parsed.data;

    const { data: tx, error } = await supabase
      .from("transactions")
      .insert({ ...txData, type: "expense", created_by: person.id, idempotency_key })
      .select("id")
      .single();
    if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
      revalidatePath(`/trips/${txData.trip_id}/transactions`);
      return { ok: true };
    }
    if (error || !tx) {
      return { ok: false, message: error?.message ?? "Buchung konnte nicht angelegt werden." };
    }
    if (txData.split_type === "individual" && participant_ids.length > 0) {
      await supabase
        .from("transaction_participants")
        .insert(participant_ids.map((pid) => ({ transaction_id: tx.id, person_id: pid })));
    }
    await logAudit(supabase, {
      table_name: "transactions",
      operation: "INSERT",
      record_id: tx.id,
      trip_id: txData.trip_id,
      actor_person_id: person.id,
      payload: { type: "expense", source: "outbox-replay", ...txData, participant_ids },
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
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: parsed.data.trip_id,
      type: "credit",
      date: parsed.data.date,
      description: parsed.data.description || "Gutschrift",
      amount: parsed.data.amount,
      credit_from: parsed.data.credit_from,
      credit_to: parsed.data.credit_to,
      created_by: person.id,
      idempotency_key: parsed.data.idempotency_key,
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && parsed.data.idempotency_key) {
    revalidatePath(`/trips/${parsed.data.trip_id}/transactions`);
    return { ok: true };
  }
  if (error || !tx) return { ok: false, message: error?.message ?? "Buchung konnte nicht angelegt werden." };
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
