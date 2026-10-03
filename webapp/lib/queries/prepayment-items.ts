/**
 * Read-Pfad für Reise-Posten (Migration 0058, Plan Teil B, PR4a).
 * Spec: docs/prepayments.md, Abschnitt „Weitere Posten".
 *
 * Alle Queries werfen bei einem Lesefehler (fail-loud), statt leer zu
 * liefern: eine leere Antwort sähe in Matrix/Bilanz wie „kein Soll" bzw.
 * „nichts bezahlt" aus — eine falsche Geldaussage ohne Spur (Lehre aus
 * getObligations/getPrepaymentPoolBalances). Wer sie im Trip-Layout nutzt,
 * muss sie wie getPrepaymentNavState einfangen.
 *
 * ⚠️ Deploy: diese Queries brauchen Migration 0058 auf Produktion — ohne die
 * Tabellen werfen sie (gewollt), die Bilanz-Seite fiele in die Error-Boundary.
 */

import { cache } from "react";
import { readClient } from "@/lib/supabase/read-client";
import { itemCellStatus, isItemComplete, type ItemCellStatus, type ItemSplitType } from "@/lib/calc/prepayment-item-shares";
import { todayIso } from "@/lib/utils";

export interface ItemPersonCell {
  person_id: string;
  soll: number;
  /** Bestätigte Crew-Zahlungen (v_prepayment_item_payments). */
  paid: number;
  /** Offene Selbstmeldungen (v_prepayment_item_pending). */
  pending: number;
  status: ItemCellStatus;
}

export interface ItemPendingPayment {
  transaction_id: string;
  person_id: string;
  amount: number;
  date: string;
  created_at: string;
}

export interface PrepaymentItemView {
  id: string;
  trip_id: string;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  label: string;
  total_amount: number;
  due_date: string | null;
  payee_person_id: string;
  split_type: ItemSplitType;
  sort_order: number;
  /** Soll/bezahlt je Person — inkl. Personen ohne Soll, die trotzdem gezahlt haben. */
  cells: ItemPersonCell[];
  sollTotal: number;
  paidTotal: number;
  pendingTotal: number;
  /** Σ Überzahlungen (paid − soll > 0) — muss zurück an die Personen (M4). */
  overpaidTotal: number;
  /** Σ offene Restbeträge (soll − paid > 0). */
  underpaidTotal: number;
  pendingPayments: ItemPendingPayment[];
  /** Σ Anbieter-Zahlungen (Ausgaben mit item_id) — Pendant getCharterPaidTotal. */
  providerPaid: number;
  /** Noch an den Anbieter zu zahlen (≥ 0). */
  providerOpen: number;
  /** Fälligkeit überschritten und Anbieter noch nicht voll bezahlt. */
  providerOverdue: boolean;
  /** Alle Soll-Zellen ✓ UND Anbieter gedeckt. */
  complete: boolean;
}

const fail = (what: string, message: string): never => {
  throw new Error(`${what} konnten nicht geladen werden: ${message}`);
};

/**
 * Σ Anbieter-Zahlungen je Posten (`type='expense'`, `item_id` gesetzt, nicht
 * gelöscht). Teilzahlungen werden summiert.
 */
export const getItemProviderPaymentsPerItem = cache(async (tripId: string): Promise<Record<string, number>> => {
  const supabase = await readClient();
  const { data, error } = await supabase
    .from("transactions")
    .select("item_id, amount")
    .eq("trip_id", tripId)
    .eq("type", "expense")
    .not("item_id", "is", null)
    .is("deleted_at", null);
  if (error) fail("Überweisungen an den Anbieter", error.message);
  const map: Record<string, number> = {};
  for (const r of data ?? []) {
    if (r.item_id) map[r.item_id] = (map[r.item_id] ?? 0) + Number(r.amount);
  }
  return map;
});

/**
 * Alle Posten eines Törns mit Soll, bestätigten/offenen Zahlungen,
 * Anbieter-Summe und Abschluss-Status. Sortiert nach sort_order, Label.
 */
export const getItems = cache(async (tripId: string): Promise<PrepaymentItemView[]> => {
  const supabase = await readClient();
  const [itemsRes, oblRes, paidRes, pendingRes, catRes, providerMap] = await Promise.all([
    supabase
      .from("prepayment_items")
      .select("id, trip_id, category_id, label, total_amount, due_date, payee_person_id, split_type, sort_order")
      .eq("trip_id", tripId)
      .order("sort_order")
      .order("label"),
    supabase.from("prepayment_item_obligations").select("item_id, person_id, amount").eq("trip_id", tripId),
    supabase.from("v_prepayment_item_payments").select("item_id, person_id, paid_amount").eq("trip_id", tripId),
    supabase
      .from("v_prepayment_item_pending")
      .select("transaction_id, item_id, person_id, amount, date, created_at")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false }),
    supabase.from("trip_categories").select("id, name, icon").eq("trip_id", tripId),
    getItemProviderPaymentsPerItem(tripId),
  ]);
  if (itemsRes.error) fail("Weitere Zahlungen", itemsRes.error.message);
  if (oblRes.error) fail("Sollbeträge der weiteren Zahlungen", oblRes.error.message);
  if (paidRes.error) fail("Einzahlungen der weiteren Zahlungen", paidRes.error.message);
  if (pendingRes.error) fail("Meldungen der weiteren Zahlungen", pendingRes.error.message);
  if (catRes.error) fail("Kategorien", catRes.error.message);

  const catById = new Map((catRes.data ?? []).map((c) => [c.id as string, c]));
  const today = todayIso();

  return (itemsRes.data ?? []).map((it) => {
    const id = it.id as string;
    const sollBy = new Map<string, number>();
    for (const o of oblRes.data ?? []) if (o.item_id === id) sollBy.set(o.person_id, Number(o.amount));
    const paidBy = new Map<string, number>();
    for (const p of paidRes.data ?? []) {
      if (p.item_id === id && p.person_id) paidBy.set(p.person_id, Number(p.paid_amount));
    }
    const pendingPayments: ItemPendingPayment[] = (pendingRes.data ?? [])
      .filter((p) => p.item_id === id && p.person_id)
      .map((p) => ({
        transaction_id: p.transaction_id as string,
        person_id: p.person_id as string,
        amount: Number(p.amount),
        date: p.date as string,
        created_at: p.created_at as string,
      }));
    const pendingBy = new Map<string, number>();
    for (const p of pendingPayments) pendingBy.set(p.person_id, (pendingBy.get(p.person_id) ?? 0) + p.amount);

    const personIds = new Set([...sollBy.keys(), ...paidBy.keys(), ...pendingBy.keys()]);
    const cells: ItemPersonCell[] = [...personIds].map((person_id) => {
      const soll = sollBy.get(person_id) ?? 0;
      const paid = paidBy.get(person_id) ?? 0;
      const pending = pendingBy.get(person_id) ?? 0;
      return { person_id, soll, paid, pending, status: itemCellStatus(soll, paid, pending) };
    });

    const total = Number(it.total_amount);
    const providerPaid = providerMap[id] ?? 0;
    const providerOpen = Math.max(0, total - providerPaid);
    const cat = it.category_id ? catById.get(it.category_id) : undefined;
    return {
      id,
      trip_id: it.trip_id as string,
      category_id: (it.category_id as string | null) ?? null,
      category_name: (cat?.name as string | undefined) ?? null,
      category_icon: (cat?.icon as string | null | undefined) ?? null,
      label: it.label as string,
      total_amount: total,
      due_date: (it.due_date as string | null) ?? null,
      payee_person_id: it.payee_person_id as string,
      split_type: it.split_type as ItemSplitType,
      sort_order: Number(it.sort_order),
      cells,
      sollTotal: cells.reduce((s, c) => s + c.soll, 0),
      paidTotal: cells.reduce((s, c) => s + c.paid, 0),
      pendingTotal: cells.reduce((s, c) => s + c.pending, 0),
      overpaidTotal: cells.reduce((s, c) => s + Math.max(0, c.paid - c.soll), 0),
      underpaidTotal: cells.reduce((s, c) => s + Math.max(0, c.soll - c.paid), 0),
      pendingPayments,
      providerPaid,
      providerOpen,
      providerOverdue: !!it.due_date && (it.due_date as string) < today && providerOpen > 0.005,
      complete: isItemComplete({ totalAmount: total, providerPaid, cells }),
    };
  });
});

/**
 * Posten-Saldo je Person (Delta-Review Punkt 3) — exakt die Posten-Anteile von
 * v_balances, nur auf Buchungen mit item_id beschränkt:
 *   + Anbieter-Zahlungen (paid_by)   − eigene per_person-Anteile daran
 *   + bestätigte Gutschriften gegeben − bestätigte Gutschriften erhalten
 * Σ über alle Personen = 0. Beispiel: Empfänger P zahlt 300 an den Anbieter
 * (Soll je 100 für P, A, B), A zahlt P 100 → P +100, A 0, B −100.
 * Damit ist Gesamt = Bordkasse + Charter-Pool + Posten, ohne ein
 * Matrix-Soll (das evtl. von den gebuchten Anteilen abweicht) einzumischen.
 */
export const getItemPotBalances = cache(async (tripId: string): Promise<Map<string, number>> => {
  const supabase = await readClient();
  const { data: txs, error } = await supabase
    .from("transactions")
    .select("id, type, amount, paid_by, credit_from, credit_to, confirmed_at")
    .eq("trip_id", tripId)
    .not("item_id", "is", null)
    .is("deleted_at", null);
  if (error) fail("Buchungen der weiteren Zahlungen", error.message);
  const live = (txs ?? []).filter((t) => t.type === "expense" || t.confirmed_at);
  const expenseIds = live.filter((t) => t.type === "expense").map((t) => t.id as string);
  let parts: { transaction_id: string; person_id: string; amount: number | null }[] = [];
  if (expenseIds.length > 0) {
    const res = await supabase
      .from("transaction_participants")
      .select("transaction_id, person_id, amount")
      .in("transaction_id", expenseIds);
    if (res.error) fail("Anteile der weiteren Zahlungen", res.error.message);
    parts = (res.data ?? []) as typeof parts;
  }
  const cents = new Map<string, number>();
  const add = (p: string | null, v: number) => {
    if (!p) return;
    cents.set(p, (cents.get(p) ?? 0) + Math.round(v * 100));
  };
  for (const t of live) {
    if (t.type === "expense") add(t.paid_by as string | null, Number(t.amount));
    else {
      add(t.credit_from as string | null, Number(t.amount));
      add(t.credit_to as string | null, -Number(t.amount));
    }
  }
  for (const p of parts) add(p.person_id, -Number(p.amount ?? 0));
  return new Map([...cents].map(([k, v]) => [k, v / 100]));
});
