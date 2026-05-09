import { getSimplifiedDebts } from "@/lib/queries/balances";
import { formatEuro } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import { DebtCheckbox } from "./debt-checkbox";

export default async function DebtsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const debts = await getSimplifiedDebts(id);

  if (debts.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 text-center">
        <div className="text-3xl mb-3">🎉</div>
        <p className="font-medium">Alles ausgeglichen</p>
        <p className="mt-1 text-sm text-ink-soft">
          Keine offenen Schulden — entweder noch nichts erfasst oder alle Salden = 0.
        </p>
      </main>
    );
  }

  const total = debts.reduce((a, d) => a + d.amount, 0);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      <header className="mb-4">
        <h1 className="text-lg font-bold text-primary">Schulden</h1>
        <p className="mt-1 text-xs text-ink-soft">
          {debts.length} Überweisungen · gesamt {formatEuro(total)}
        </p>
      </header>

      <ul className="space-y-2">
        {debts.map((d, idx) => (
          <li
            key={`${d.from_person_id}-${d.to_person_id}-${idx}`}
            className="flex items-center gap-3 rounded-md border border-rule bg-paper p-3"
          >
            <DebtCheckbox tripId={id} debtKey={`${d.from_person_id}-${d.to_person_id}-${idx}`} />
            <div className="flex flex-1 items-center gap-2">
              <span className="font-medium">{d.from_name}</span>
              <ArrowRight className="h-4 w-4 text-ink-soft" />
              <span className="font-medium">{d.to_name}</span>
            </div>
            <span className="font-semibold tabular-nums text-primary">
              {formatEuro(d.amount)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-ink-soft">
        Häkchen-Status wird nur lokal im Browser gespeichert — nicht synchron zur Crew.
        Bei N Personen sind maximal N-1 Überweisungen nötig (Greedy).
      </p>
    </main>
  );
}
