/**
 * Read-Pfad für das Anzahlungs-Modul.
 * Spec: docs/prepayments.md
 */

import { readClient } from "@/lib/supabase/read-client";
import type { PrepaymentSplitMethod } from "@/lib/validation/prepayment-schema";

export interface PrepaymentPlan {
  trip_id: string;
  split_method: PrepaymentSplitMethod;
  total_amount: number;
  /** Vorstrecker der Yacht-Anzahlung. NULL = Trip-Skipper. */
  advancer_person_id: string | null;
  wero_id: string | null;
  whatsapp_template: string | null;
}

export interface CabinType {
  id: string;
  trip_id: string;
  label: string;
  price_per_person: number;
  capacity: number;
  sort_order: number;
}

export interface Tranche {
  id: string;
  trip_id: string;
  due_date: string;
  label: string;
  percent: number;
  wero_request_link: string | null;
  sort_order: number;
}

export interface Obligation {
  trip_id: string;
  person_id: string;
  cabin_type_id: string | null;
  total_amount: number;
}

export async function getPlan(tripId: string): Promise<PrepaymentPlan | null> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("prepayment_plan")
    .select("trip_id, split_method, total_amount, advancer_person_id, wero_id, whatsapp_template")
    .eq("trip_id", tripId)
    .maybeSingle();
  if (!data) return null;
  return {
    ...data,
    total_amount: Number(data.total_amount),
  } as PrepaymentPlan;
}

export async function getCabinTypes(tripId: string): Promise<CabinType[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("cabin_types")
    .select("id, trip_id, label, price_per_person, capacity, sort_order")
    .eq("trip_id", tripId)
    .order("sort_order")
    .order("label");
  return (data ?? []).map((c) => ({
    ...c,
    price_per_person: Number(c.price_per_person),
  })) as CabinType[];
}

export async function getTranches(tripId: string): Promise<Tranche[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("prepayment_tranches")
    .select("id, trip_id, due_date, label, percent, wero_request_link, sort_order")
    .eq("trip_id", tripId)
    .order("sort_order")
    .order("due_date");
  return (data ?? []).map((t) => ({
    ...t,
    percent: Number(t.percent),
  })) as Tranche[];
}

export async function getObligations(tripId: string): Promise<Obligation[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("prepayment_obligations")
    .select("trip_id, person_id, cabin_type_id, total_amount")
    .eq("trip_id", tripId);
  return (data ?? []).map((o) => ({
    ...o,
    total_amount: Number(o.total_amount),
  })) as Obligation[];
}

export interface PaymentAggregate {
  /** trip_id ist konstant, hier nicht im Key */
  tranche_id: string;
  person_id: string;
  paid_amount: number;
}

/**
 * Aggregierte Eingangs-Zahlungen pro (tranche_id, person_id).
 * Quelle: v_prepayment_payments (Gutschriften credit_from -> Skipper mit tranche_id ≠ NULL).
 */
export async function getPaymentAggregates(tripId: string): Promise<PaymentAggregate[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("v_prepayment_payments")
    .select("tranche_id, person_id, paid_amount")
    .eq("trip_id", tripId);
  return (data ?? [])
    .filter((p) => p.tranche_id && p.person_id)
    .map((p) => ({
      tranche_id: p.tranche_id as string,
      person_id: p.person_id as string,
      paid_amount: Number(p.paid_amount),
    }));
}

/** Einzelne Zahlungen einer Tranche-Person-Kombination (für Detail-Modal). */
export interface PaymentEntry {
  id: string;
  date: string;
  amount: number;
  description: string | null;
  created_by_id: string | null;
}

/**
 * Anzahlungs-Pool-Saldo pro Person (Eingänge − Soll).
 * Positiver Wert = die Person hat mehr eingezahlt, als sie schuldet.
 * Negativer Wert = die Person ist mit Anzahlungen noch im Rückstand.
 *
 * Wird in der Bilanz-Drei-Block-Ansicht verwendet.
 */
export interface PrepaymentPoolBalance {
  person_id: string;
  soll: number;
  paid: number;
  /** paid − soll: + = überzahlt / Guthaben, − = offen */
  balance: number;
}

export async function getPrepaymentPoolBalances(tripId: string): Promise<PrepaymentPoolBalance[]> {
  const supabase = await readClient();
  const [{ data: oblRows }, { data: payRows }] = await Promise.all([
    supabase
      .from("prepayment_obligations")
      .select("person_id, total_amount")
      .eq("trip_id", tripId),
    supabase
      .from("v_prepayment_payments")
      .select("person_id, paid_amount")
      .eq("trip_id", tripId),
  ]);

  const sollById = new Map<string, number>();
  for (const o of oblRows ?? []) sollById.set(o.person_id, Number(o.total_amount));

  const paidById = new Map<string, number>();
  for (const p of payRows ?? []) {
    if (!p.person_id) continue;
    paidById.set(p.person_id, (paidById.get(p.person_id) ?? 0) + Number(p.paid_amount));
  }

  const ids = new Set([...sollById.keys(), ...paidById.keys()]);
  return [...ids].map((person_id) => {
    const soll = sollById.get(person_id) ?? 0;
    const paid = paidById.get(person_id) ?? 0;
    return { person_id, soll, paid, balance: paid - soll };
  });
}

/**
 * Pro Tranche: was hat der Vorstrecker schon als Ausgabe (an die
 * Charteragentur) erfasst? Wird im Reminder-Banner verwendet, um zu
 * zeigen, was noch zu überweisen ist.
 *
 * Eine Skipper→Charter-Überweisung ist eine `transactions.type='expense'`
 * Buchung mit `tranche_id` ≠ NULL und `paid_by` = der Vorstrecker.
 */
export async function getCharterPaymentsPerTranche(tripId: string): Promise<Record<string, number>> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("transactions")
    .select("tranche_id, amount")
    .eq("trip_id", tripId)
    .eq("type", "expense")
    .is("deleted_at", null)
    .not("tranche_id", "is", null);
  const map: Record<string, number> = {};
  for (const r of data ?? []) {
    if (r.tranche_id) {
      map[r.tranche_id] = (map[r.tranche_id] ?? 0) + Number(r.amount);
    }
  }
  return map;
}

/**
 * Selbst-Meldungen (Phase 2): noch nicht vom Skipper bestätigte
 * Anzahlungs-Gutschriften. Wird im Matrix-UI für ⏳-Indikatoren benutzt.
 */
export interface PendingPayment {
  transaction_id: string;
  tranche_id: string;
  person_id: string;
  amount: number;
  date: string;
  description: string | null;
  created_at: string;
}

export async function getPendingPayments(tripId: string): Promise<PendingPayment[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("v_prepayment_pending")
    .select("transaction_id, tranche_id, person_id, amount, date, description, created_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((p) => ({
    transaction_id: p.transaction_id as string,
    tranche_id: p.tranche_id as string,
    person_id: p.person_id as string,
    amount: Number(p.amount),
    date: p.date as string,
    description: p.description as string | null,
    created_at: p.created_at as string,
  }));
}

export async function listPaymentsFor(
  tripId: string,
  trancheId: string,
  personId: string,
): Promise<PaymentEntry[]> {
  const supabase = await readClient();
  const { data } = await supabase
    .from("transactions")
    .select("id, date, amount, description, created_by")
    .eq("trip_id", tripId)
    .eq("tranche_id", trancheId)
    .eq("credit_from", personId)
    .eq("type", "credit")
    .is("deleted_at", null)
    .order("date", { ascending: false });
  return (data ?? []).map((t) => ({
    id: t.id,
    date: t.date,
    amount: Number(t.amount),
    description: t.description,
    created_by_id: t.created_by,
  }));
}
