import { getBalances } from "@/lib/queries/balances";
import { formatEuro } from "@/lib/utils";

export default async function BalancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rows = await getBalances(id);

  if (rows.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 text-center">
        <div className="text-3xl mb-3">⚖️</div>
        <p className="font-medium">Noch keine Crew angelegt</p>
        <p className="mt-1 text-sm text-ink-soft">
          Lege erst Crew + Buchungen an, dann erscheint hier die Bilanz.
        </p>
      </main>
    );
  }

  // Saldo-Summe für Sanity-Check
  const sum = rows.reduce((a, r) => a + r.balance, 0);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      <h1 className="mb-4 text-lg font-bold text-primary">Bilanz</h1>

      <div className="overflow-hidden rounded-md border border-rule bg-paper">
        <table className="w-full text-sm">
          <thead className="bg-paper-soft text-xs text-ink-soft">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Person</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Bezahlt</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Anteil</th>
              <th className="px-3 py-2 text-right font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.person_id} className="border-t border-rule">
                <td className="px-3 py-2 font-medium">{r.display_name}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-ink-soft sm:table-cell">
                  {r.paid > 0 ? formatEuro(r.paid) : "—"}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-ink-soft sm:table-cell">
                  {r.share > 0 ? formatEuro(r.share) : "—"}
                </td>
                <td
                  className={`px-3 py-2 text-right font-semibold tabular-nums ${
                    r.balance > 0.005
                      ? "text-success"
                      : r.balance < -0.005
                      ? "text-danger"
                      : "text-ink-soft"
                  }`}
                >
                  {formatEuro(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Math.abs(sum) > 0.05 && (
        <p className="mt-3 text-xs text-danger">
          ⚠️ Saldo-Summe ist {formatEuro(sum)} statt 0 — könnte ein Rundungsfehler oder Datenproblem sein.
        </p>
      )}

      <p className="mt-4 text-xs text-ink-soft">
        Grün = bekommt Geld zurück. Rot = muss noch zahlen. Saldo-Summe sollte 0 € sein.
      </p>
    </main>
  );
}
