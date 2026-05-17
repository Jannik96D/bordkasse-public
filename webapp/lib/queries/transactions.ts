import { readClient } from "@/lib/supabase/read-client";

export interface TransactionShareRow {
  person_id: string;
  display_name: string;
  share: number;
  /** Bei split_type='per_person': der eingetragene Betrag dieser Person. */
  participant_amount: number | null;
  /** Bei split_type='individual': Person ist explizit als Beteiligter markiert. */
  is_participant: boolean;
  /** Trinker-Flag aus trip_members / persons. Relevant für Alkohol-Verteilung. */
  is_alcoholic: boolean;
}

export interface TransactionDetail {
  id: string;
  trip_id: string;
  type: "expense" | "credit";
  date: string;
  description: string | null;
  amount: number;
  alcohol_amount: number;
  tip_amount: number;
  split_type: TransactionListRow["split_type"];
  paid_by_id: string | null;
  paid_by_name: string | null;
  credit_from_id: string | null;
  credit_from_name: string | null;
  credit_to_id: string | null;
  credit_to_name: string | null; // null = "Alle" wenn type=credit
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  /** Pro-Person-Aufschlüsselung (nur expense). Aus v_transaction_shares. */
  shares: TransactionShareRow[];
}

export interface TransactionListRow {
  id: string;
  type: "expense" | "credit";
  date: string;
  description: string | null;
  amount: number;
  alcohol_amount: number;
  tip_amount: number;
  split_type: "equal" | "on_board" | "time_proportional" | "individual" | "per_person" | null;
  paid_by_name: string | null;
  category_name: string | null;
  category_icon: string | null;
  credit_from_name: string | null;
  credit_to_name: string | null;  // null = "Alle" wenn type=credit
  /** Ersteller — gebraucht für Edit-Permission-Check in der Liste. */
  created_by_id: string | null;
}

export async function listTransactions(tripId: string): Promise<TransactionListRow[]> {
  const supabase = await readClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      id, type, date, description, amount, alcohol_amount, tip_amount, split_type,
      paid_by, credit_from, credit_to, created_by,
      paid_person:persons!transactions_paid_by_fkey(display_name),
      from_person:persons!transactions_credit_from_fkey(display_name),
      to_person:persons!transactions_credit_to_fkey(display_name),
      category:trip_categories(name, icon)
    `)
    .eq("trip_id", tripId)
    .is("deleted_at", null)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  type Raw = {
    id: string;
    type: "expense" | "credit";
    date: string;
    description: string | null;
    amount: number;
    alcohol_amount: number;
    tip_amount: number;
    split_type: TransactionListRow["split_type"];
    paid_by: string | null;
    credit_from: string | null;
    credit_to: string | null;
    created_by: string | null;
    paid_person: { display_name: string } | { display_name: string }[] | null;
    from_person: { display_name: string } | { display_name: string }[] | null;
    to_person: { display_name: string } | { display_name: string }[] | null;
    category: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
  };

  const first = <T,>(v: T | T[] | null): T | null =>
    v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

  return (data as unknown as Raw[]).map((r): TransactionListRow => ({
    id: r.id,
    type: r.type,
    date: r.date,
    description: r.description,
    amount: Number(r.amount),
    alcohol_amount: Number(r.alcohol_amount),
    tip_amount: Number(r.tip_amount ?? 0),
    split_type: r.split_type,
    paid_by_name: first(r.paid_person)?.display_name ?? null,
    category_name: first(r.category)?.name ?? null,
    category_icon: first(r.category)?.icon ?? null,
    credit_from_name: first(r.from_person)?.display_name ?? null,
    credit_to_name: r.type === "credit" && r.credit_to == null
      ? null  // → "Alle"
      : first(r.to_person)?.display_name ?? null,
    created_by_id: r.created_by,
  }));
}

/**
 * Holt eine einzelne Transaktion samt Pro-Person-Aufschlüsselung. Wird auf
 * der Detail-Seite genutzt, die jede Crew-Person aufrufen darf.
 *
 * Quellen:
 *   - `transactions` für Kopf-Daten
 *   - `v_transaction_shares` für berechnete Anteile pro Crew (matches SQL,
 *     keine TS-Duplikation der Logik)
 *   - `transaction_participants` für per_person-Beträge + individual-Marker
 */
export async function getTransactionDetail(
  txId: string,
  tripId: string,
): Promise<TransactionDetail | null> {
  const supabase = await readClient();

  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .select(`
      id, trip_id, type, date, description, amount, alcohol_amount, tip_amount, split_type,
      paid_by, category_id, credit_from, credit_to, created_by, deleted_at,
      paid_person:persons!transactions_paid_by_fkey(display_name),
      from_person:persons!transactions_credit_from_fkey(display_name),
      to_person:persons!transactions_credit_to_fkey(display_name),
      created_person:persons!transactions_created_by_fkey(display_name),
      category:trip_categories(name, icon)
    `)
    .eq("id", txId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (txErr || !tx) return null;
  type TxRaw = {
    id: string;
    trip_id: string;
    type: "expense" | "credit";
    date: string;
    description: string | null;
    amount: number;
    alcohol_amount: number;
    tip_amount: number;
    split_type: TransactionListRow["split_type"];
    paid_by: string | null;
    category_id: string | null;
    credit_from: string | null;
    credit_to: string | null;
    created_by: string | null;
    deleted_at: string | null;
    paid_person: { display_name: string } | { display_name: string }[] | null;
    from_person: { display_name: string } | { display_name: string }[] | null;
    to_person: { display_name: string } | { display_name: string }[] | null;
    created_person: { display_name: string } | { display_name: string }[] | null;
    category: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
  };
  const t = tx as unknown as TxRaw;
  if (t.deleted_at) return null;

  const first = <T,>(v: T | T[] | null): T | null =>
    v == null ? null : Array.isArray(v) ? v[0] ?? null : v;

  // Shares + Crew-Namen + Alkohol-Flag + Participant-Marker in einem Rutsch.
  // v_transaction_shares filtert auf trip-scoped, der Join über trip_members
  // bringt is_alcoholic und Name. transaction_participants liefert den
  // per_person-Betrag bzw. den individual-Marker.
  const [{ data: sharesRaw }, { data: crewRaw }, { data: participantsRaw }] = await Promise.all([
    supabase
      .from("v_transaction_shares")
      .select("person_id, share")
      .eq("transaction_id", txId),
    supabase
      .from("trip_members")
      .select(`
        person_id, is_alcoholic,
        person:persons(display_name, is_alcoholic)
      `)
      .eq("trip_id", tripId),
    supabase
      .from("transaction_participants")
      .select("person_id, amount")
      .eq("transaction_id", txId),
  ]);

  type CrewRaw = {
    person_id: string;
    is_alcoholic: boolean | null;
    person: { display_name: string; is_alcoholic: boolean | null } | { display_name: string; is_alcoholic: boolean | null }[] | null;
  };

  const sharesById = new Map<string, number>(
    ((sharesRaw ?? []) as Array<{ person_id: string; share: number }>).map((s) => [s.person_id, Number(s.share)]),
  );
  const participantsById = new Map<string, number | null>(
    ((participantsRaw ?? []) as Array<{ person_id: string; amount: number | null }>).map(
      (p) => [p.person_id, p.amount == null ? null : Number(p.amount)],
    ),
  );

  const shares: TransactionShareRow[] = (crewRaw as unknown as CrewRaw[] | null ?? []).map((c) => {
    const person = first(c.person);
    return {
      person_id: c.person_id,
      display_name: person?.display_name ?? "?",
      share: sharesById.get(c.person_id) ?? 0,
      participant_amount: participantsById.has(c.person_id) ? participantsById.get(c.person_id)! : null,
      is_participant: participantsById.has(c.person_id),
      is_alcoholic: c.is_alcoholic ?? person?.is_alcoholic ?? false,
    };
  });

  return {
    id: t.id,
    trip_id: t.trip_id,
    type: t.type,
    date: t.date,
    description: t.description,
    amount: Number(t.amount),
    alcohol_amount: Number(t.alcohol_amount),
    tip_amount: Number(t.tip_amount ?? 0),
    split_type: t.split_type,
    paid_by_id: t.paid_by,
    paid_by_name: first(t.paid_person)?.display_name ?? null,
    credit_from_id: t.credit_from,
    credit_from_name: first(t.from_person)?.display_name ?? null,
    credit_to_id: t.credit_to,
    credit_to_name: t.credit_to == null ? null : first(t.to_person)?.display_name ?? null,
    category_id: t.category_id,
    category_name: first(t.category)?.name ?? null,
    category_icon: first(t.category)?.icon ?? null,
    created_by_id: t.created_by,
    created_by_name: first(t.created_person)?.display_name ?? null,
    shares,
  };
}
