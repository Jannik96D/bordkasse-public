import { Euro } from "lucide-react";
import { listTransactions } from "@/lib/queries/transactions";
import { getTripMembers } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { FabAddTransaction } from "@/components/bottom-nav";
import { TransactionsList } from "./transactions-list";

export default async function TransactionsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const initialQuery = typeof sp.q === "string" ? sp.q : "";
  const [txs, members, person, admin] = await Promise.all([
    listTransactions(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
  ]);
  // canEdit-Check pro Row: Skipper / Co-Skipper / Admin / Ersteller.
  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;

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
        <TransactionsList
          tripId={id}
          rows={txs}
          currentPersonId={person?.id ?? null}
          isMyTripSkipper={isMyTripSkipper}
          isAdmin={admin}
          initialQuery={initialQuery}
        />
      )}

      <FabAddTransaction tripId={id} />
    </main>
  );
}
