import { createClient } from "@/lib/supabase/server";

export interface TransactionListRow {
  id: string;
  type: "expense" | "credit";
  date: string;
  description: string | null;
  amount: number;
  alcohol_amount: number;
  split_type: "equal" | "on_board" | "time_proportional" | "individual" | null;
  paid_by_name: string | null;
  category_name: string | null;
  credit_from_name: string | null;
  credit_to_name: string | null;  // null = "Alle" wenn type=credit
}

export async function listTransactions(tripId: string): Promise<TransactionListRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      id, type, date, description, amount, alcohol_amount, split_type,
      paid_by, credit_from, credit_to,
      paid_person:persons!transactions_paid_by_fkey(display_name),
      from_person:persons!transactions_credit_from_fkey(display_name),
      to_person:persons!transactions_credit_to_fkey(display_name),
      category:trip_categories(name)
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
    split_type: TransactionListRow["split_type"];
    paid_by: string | null;
    credit_from: string | null;
    credit_to: string | null;
    paid_person: { display_name: string } | { display_name: string }[] | null;
    from_person: { display_name: string } | { display_name: string }[] | null;
    to_person: { display_name: string } | { display_name: string }[] | null;
    category: { name: string } | { name: string }[] | null;
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
    split_type: r.split_type,
    paid_by_name: first(r.paid_person)?.display_name ?? null,
    category_name: first(r.category)?.name ?? null,
    credit_from_name: first(r.from_person)?.display_name ?? null,
    credit_to_name: r.type === "credit" && r.credit_to == null
      ? null  // → "Alle"
      : first(r.to_person)?.display_name ?? null,
  }));
}
