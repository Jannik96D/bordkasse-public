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
          <caption className="sr-only">
            Bilanz der Crew: Saldo pro Person. Positive Beträge bekommen Geld zurück, negative zahlen nach.
          </caption>
          <thead className="bg-paper-soft text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Person</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">Bezahlt</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">Anteil</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Saldo <span className="font-normal">(+ erhält, − zahlt)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isPositive = r.balance > 0.005;
              const isNegative = r.balance < -0.005;
              const sign = isPositive ? "+" : isNegative ? "−" : "";
              const absAmount = formatEuro(Math.abs(r.balance));
              const srText = isPositive
                ? `${r.display_name} bekommt ${absAmount} zurück`
                : isNegative
                ? `${r.display_name} zahlt ${absAmount} nach`
                : `${r.display_name} ist ausgeglichen`;
              return (
                <tr key={r.person_id} className="border-t border-rule">
                  <th scope="row" className="px-3 py-2 text-left font-medium">{r.display_name}</th>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-ink-soft sm:table-cell">
                    {r.paid > 0 ? formatEuro(r.paid) : "—"}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-ink-soft sm:table-cell">
                    {r.share > 0 ? formatEuro(r.share) : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-semibold tabular-nums ${
                      isPositive
                        ? "text-success"
                        : isNegative
                        ? "text-danger"
                        : "text-ink-soft"
                    }`}
                  >
                    <span className="sr-only">{srText}</span>
                    <span aria-hidden>
                      {sign}
                      {absAmount}
                    </span>
                  </td>
                </tr>
              );
            })}
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
