import Link from "next/link";
import { InfoTooltip } from "@/components/info-tooltip";
import { getBalances, getBordkasseOnlyBalances } from "@/lib/queries/balances";
import { getTrip } from "@/lib/queries/trips";
import { getPlan, getPrepaymentPoolBalances, getCharterPaidTotal } from "@/lib/queries/prepayments";
import { formatEuro, todayIso } from "@/lib/utils";
import type { PrepaymentPoolBalance } from "@/lib/queries/prepayments";
import type { BalanceRow } from "@/lib/queries/balances";

export default async function BalancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [rows, bordkasseRows, plan, poolBalances, trip, charterPaid] = await Promise.all([
    getBalances(id),
    getBordkasseOnlyBalances(id),
    getPlan(id),
    getPrepaymentPoolBalances(id),
    getTrip(id),
    getCharterPaidTotal(id),
  ]);

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

  // Bordkasse-Tabelle nutzt v_balances_bordkasse_only wenn ein Plan existiert
  // (sonst v_balances), damit Anzahlungs-Buchungen die Bordkasse-Bilanz nicht
  // verfälschen.
  const tableRows: BalanceRow[] = plan ? bordkasseRows.map((b) => ({
    ...b,
    display_name: rows.find((r) => r.person_id === b.person_id)?.display_name ?? "—",
  })) : rows;
  const sum = tableRows.reduce((a, r) => a + r.balance, 0);

  // Reihenfolge der beiden Blöcke:
  //   - vor Trip-Start: Anzahlungs-Übersicht oben (das ist der aktive Workflow)
  //   - ab Trip-Tag 1: Bordkasse oben (Anzahlung ist abgeschlossen, jetzt laufen die Trip-Kosten)
  const tripStarted = !!trip && trip.start_date <= todayIso();
  const hasPlan = !!plan;
  const nameById = new Map(rows.map((r) => [r.person_id, r.display_name]));

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      <h1 className="mb-4 text-lg font-bold text-primary">
        Bilanz
        {hasPlan && (
          <InfoTooltip
            label="Bilanz-Blöcke erklärt"
            text="Diese Bilanz hat zwei Töpfe: „Anzahlung“ ist das Geld für die Yacht-Charter, das vorab an die Agentur gezahlt wird. „Bordkasse“ sind die laufenden Kosten während des Törns (Sprit, Hafen, Essen). „Gesamt“ fasst beide zusammen — das ist unterm Strich dein Saldo."
          />
        )}
      </h1>

      {!tripStarted && hasPlan && (
        <PrepaymentsSummary
          tripId={id}
          poolBalances={poolBalances}
          nameById={nameById}
          planTotal={plan?.total_amount ?? 0}
          charterPaid={charterPaid}
        />
      )}

      <BordkasseTable rows={tableRows} sum={sum} hasPlan={hasPlan} />

      {tripStarted && hasPlan && (
        <PrepaymentsSummary
          tripId={id}
          poolBalances={poolBalances}
          nameById={nameById}
          planTotal={plan?.total_amount ?? 0}
          charterPaid={charterPaid}
        />
      )}
    </main>
  );
}

/**
 * Anzahlungs-Übersicht — Bezahlt/Soll pro Person mit Status-Icon.
 * Klare „X € / Y €"-Anzeige, kein abstrakter Saldo.
 */
function PrepaymentsSummary({
  tripId,
  poolBalances,
  nameById,
  planTotal,
  charterPaid,
}: {
  tripId: string;
  poolBalances: PrepaymentPoolBalance[];
  nameById: Map<string, string>;
  /** Gesamt-Anzahlungssumme aus dem Plan (= Charter-Preis ggü. Agentur). */
  planTotal: number;
  /** Σ aller Charter-Überweisungen (Vorstrecker → Vercharterer). */
  charterPaid: number;
}) {
  // Σ Crew-Beiträge (für Header-Zeile)
  const sumSoll = poolBalances.reduce((s, p) => s + p.soll, 0);
  const sumPaid = poolBalances.reduce((s, p) => s + Math.min(p.paid, p.soll), 0);
  const sumOpen = Math.max(0, sumSoll - sumPaid);

  // Charter-Auslage: was wurde an die Agentur überwiesen vs. Soll
  const charterSoll = planTotal;
  const charterOpen = Math.max(0, charterSoll - charterPaid);
  const charterFulfilled = charterSoll > 0 && charterOpen <= 0.005;

  return (
    <section className="mb-4 rounded-lg border border-rule bg-paper p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-primary">Anzahlung Yacht-Charter</h2>
        <Link className="text-xs text-primary hover:underline" href={`/trips/${tripId}/prepayments`}>
          Details →
        </Link>
      </div>

      {/* Block 1: Crew-Beiträge */}
      <p className="mb-2 text-xs uppercase tracking-wide text-ink-soft">Crew-Beiträge</p>
      <p className="mb-3 text-xs text-ink-soft">
        Insgesamt <strong className="text-ink">{formatEuro(sumPaid)}</strong> von{" "}
        <strong className="text-ink">{formatEuro(sumSoll)}</strong> bezahlt
        {sumOpen > 0.005 && <> · noch <strong className="text-danger">{formatEuro(sumOpen)}</strong> offen</>}
      </p>

      <ul className="divide-y divide-rule text-sm">
        {poolBalances
          .slice()
          .sort((a, b) => (nameById.get(a.person_id) ?? "").localeCompare(nameById.get(b.person_id) ?? ""))
          .map((p) => {
            const name = nameById.get(p.person_id) ?? "—";
            const open = Math.max(0, p.soll - p.paid);
            const overpaid = p.paid > p.soll + 0.005;
            const erfuellt = p.soll > 0 && open <= 0.005 && !overpaid;
            const status: "open" | "partial" | "paid" | "overpaid" =
              p.soll <= 0.005 ? "paid" :
              overpaid ? "overpaid" :
              erfuellt ? "paid" :
              p.paid > 0.005 ? "partial" :
              "open";
            return (
              <li key={p.person_id} className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium">{name}</span>
                <span className="inline-flex items-center gap-2 text-sm">
                  <StatusBadge status={status} />
                  <span className="tabular-nums text-ink-soft">
                    {formatEuro(p.paid)} <span className="text-ink-soft">/</span>{" "}
                    <span className="text-ink">{formatEuro(p.soll)}</span>
                  </span>
                </span>
              </li>
            );
          })}
      </ul>

      {/* Block 2: Charter-Auslage (Vorstrecker → Vercharterer) */}
      {charterSoll > 0 && (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-ink-soft">An Vercharterer überwiesen</p>
          <div className="flex items-center justify-between gap-3 rounded-md bg-paper-soft px-3 py-2 text-sm">
            <span className="font-medium">Charteranzahlung</span>
            <span className="inline-flex items-center gap-2">
              <StatusBadge status={charterFulfilled ? "paid" : charterPaid > 0.005 ? "partial" : "open"} />
              <span className="tabular-nums text-ink-soft">
                {formatEuro(charterPaid)} <span className="text-ink-soft">/</span>{" "}
                <span className="text-ink">{formatEuro(charterSoll)}</span>
              </span>
            </span>
          </div>
          {charterOpen > 0.005 && (
            <p className="mt-2 text-xs text-ink-soft">
              Noch <strong className="text-danger">{formatEuro(charterOpen)}</strong> an die Charteragentur zu überweisen.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: "open" | "partial" | "paid" | "overpaid" }) {
  if (status === "paid") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded border-2 border-success bg-success text-paper" aria-label="erfüllt">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3,8 7,12 13,4" />
        </svg>
      </span>
    );
  }
  if (status === "overpaid") {
    return (
      <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border-2 border-primary bg-primary px-1 text-[10px] font-bold text-paper" aria-label="überzahlt">
        +
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded border-2 border-primary bg-paper text-xs font-bold text-primary" aria-label="teilweise bezahlt">
        ◐
      </span>
    );
  }
  return (
    <span className="inline-block h-5 w-5 rounded border-2 border-rule bg-paper" aria-label="offen" />
  );
}

function BordkasseTable({ rows, sum, hasPlan }: { rows: BalanceRow[]; sum: number; hasPlan: boolean }) {
  return (
    <>
      <h2 className="mb-2 text-sm font-semibold text-primary">
        {hasPlan ? "Bordkasse — laufende Trip-Kosten" : "Bilanz"}
      </h2>
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
                      isPositive ? "text-success" : isNegative ? "text-danger" : "text-ink-soft"
                    }`}
                  >
                    <span className="sr-only">{srText}</span>
                    <span aria-hidden>{sign}{absAmount}</span>
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

      <p className="mb-4 mt-4 text-xs text-ink-soft">
        Grün = bekommt Geld zurück. Rot = muss noch zahlen. Saldo-Summe sollte 0 € sein.
      </p>
    </>
  );
}
