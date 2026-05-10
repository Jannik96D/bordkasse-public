import { ArrowRight } from "lucide-react";
import { getSimplifiedDebts } from "@/lib/queries/balances";
import { getSettledDebtKeys, debtKey } from "@/lib/queries/settled-debts";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { formatEuro } from "@/lib/utils";
import { DebtCheckbox } from "./debt-checkbox";

export default async function DebtsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [debts, settled, person, admin] = await Promise.all([
    getSimplifiedDebts(id),
    getSettledDebtKeys(id),
    getCurrentPerson(),
    isAdmin(),
  ]);

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
  const settledCount = debts.filter((d) =>
    settled.has(debtKey(d.from_person_id, d.to_person_id, d.amount)),
  ).length;
  const openCount = debts.length - settledCount;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      <header className="mb-4">
        <h1 className="text-lg font-bold text-primary">Schulden</h1>
        <p className="mt-1 text-xs text-ink-soft">
          {debts.length} Überweisungen · gesamt {formatEuro(total)}
          {settledCount > 0 && (
            <>
              {" · "}
              <span className="text-success">{settledCount} erledigt</span>
              {", "}
              {openCount} offen
            </>
          )}
        </p>
      </header>

      <ul className="space-y-2">
        {debts.map((d, idx) => {
          const isSettled = settled.has(
            debtKey(d.from_person_id, d.to_person_id, d.amount),
          );
          return (
            <li
              key={`${d.from_person_id}-${d.to_person_id}-${idx}`}
              className={
                isSettled
                  ? "flex items-center gap-3 rounded-md border border-rule bg-paper-soft p-3 opacity-60"
                  : "flex items-center gap-3 rounded-md border border-rule bg-paper p-3"
              }
            >
              <DebtCheckbox
                tripId={id}
                fromPersonId={d.from_person_id}
                toPersonId={d.to_person_id}
                amount={d.amount}
                initialSettled={isSettled}
                canToggle={
                  admin ||
                  person?.id === d.from_person_id ||
                  person?.id === d.to_person_id
                }
              />
              <div className="flex flex-1 items-center gap-2">
                <span className={isSettled ? "font-medium line-through" : "font-medium"}>
                  {d.from_name}
                </span>
                <ArrowRight className="h-4 w-4 text-ink-soft" />
                <span className={isSettled ? "font-medium line-through" : "font-medium"}>
                  {d.to_name}
                </span>
              </div>
              <span
                className={
                  isSettled
                    ? "font-semibold tabular-nums text-ink-soft line-through"
                    : "font-semibold tabular-nums text-primary"
                }
              >
                {formatEuro(d.amount)}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-xs text-ink-soft">
        Bezahlt-Häkchen wird mit der Crew geteilt — alle sehen denselben Stand
        live. Sobald sich der Betrag durch eine neue Buchung ändert, ist die
        Schuld eine neue und das Häkchen verschwindet automatisch.
      </p>
    </main>
  );
}
