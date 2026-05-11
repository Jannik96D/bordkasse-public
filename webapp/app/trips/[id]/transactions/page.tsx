import { Euro } from "lucide-react";
import { listTransactions } from "@/lib/queries/transactions";
import { FabAddTransaction } from "@/components/bottom-nav";
import { TransactionsList } from "./transactions-list";

export default async function TransactionsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const txs = await listTransactions(id);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      {txs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-rule p-10 text-center">
          <Euro className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine Buchung</p>
          <p className="mt-1 text-sm text-ink-soft">
            Tippe auf das ➕ unten rechts, um die erste Ausgabe zu erfassen.
          </p>
        </div>
      ) : (
        <TransactionsList tripId={id} rows={txs} />
      )}

      <FabAddTransaction tripId={id} />
    </main>
  );
}
