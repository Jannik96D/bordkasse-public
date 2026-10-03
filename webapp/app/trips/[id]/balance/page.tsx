import Link from "next/link";
import { ChevronDown, Check } from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";
import { getBalances, getBordkasseOnlyBalances } from "@/lib/queries/balances";
import { getTrip } from "@/lib/queries/trips";
import { getPlan, getPrepaymentPoolBalances, getCharterPaidTotal } from "@/lib/queries/prepayments";
import { getItems, getItemPotBalances, type PrepaymentItemView } from "@/lib/queries/prepayment-items";
import { CategoryIcon } from "@/components/category-icon";
import { groupPaidCapped, itemOverallStatus, ITEM_OVERALL_LABEL } from "@/lib/prepayments/item-ui";
import { formatEuro, todayIso } from "@/lib/utils";
import { tripVocab, type TripType } from "@/lib/trip-vocab";
import type { PrepaymentPoolBalance } from "@/lib/queries/prepayments";
import type { BalanceRow } from "@/lib/queries/balances";

export default async function BalancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [rows, bordkasseRows, plan, poolBalances, trip, charterPaid, items, itemPot] = await Promise.all([
    getBalances(id),
    getBordkasseOnlyBalances(id),
    getPlan(id),
    getPrepaymentPoolBalances(id),
    getTrip(id),
    getCharterPaidTotal(id),
    getItems(id),
    getItemPotBalances(id),
  ]);

  const tripType: TripType = trip?.trip_type === "other" ? "other" : "sailing";
  const vocab = tripVocab(tripType);

  if (rows.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 text-center">
        <div className="text-3xl mb-3">⚖️</div>
        <p className="font-medium">Noch keine {vocab.crew} angelegt</p>
        <p className="mt-1 text-sm text-ink-soft">
          Lege erst {vocab.crew} + Buchungen an, dann erscheint hier die Bilanz.
        </p>
      </main>
    );
  }

  // Bordkasse-Tabelle nutzt v_balances_bordkasse_only, sobald es einen
  // Sondertopf gibt — Anzahlungsplan ODER Reise-Posten (0058, PR4a) —, sonst
  // v_balances. Sonst stünden die Flug-Zahlungen eines Törns ohne
  // Charterplan als offene Bordkasse-Salden da.
  const hasItems = items.length > 0;
  const tableRows: BalanceRow[] = plan || hasItems ? bordkasseRows.map((b) => ({
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
        {(hasPlan || hasItems) && (
          <InfoTooltip
            label="Bilanzblöcke erklärt"
            text={balanceExplanation(tripType, hasPlan, hasItems)}
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
          tripType={tripType}
        />
      )}

      <BordkasseTable rows={tableRows} sum={sum} hasPlan={hasPlan || hasItems} tripType={tripType} />

      {/* Reise-Posten: dritter Topf neben Bordkasse und Anzahlung (PR4b). */}
      {hasItems && (
        <ItemsSummary
          tripId={id}
          items={items}
          tripType={tripType}
          // M1 (PR4a-Review): je Person Posten-Saldo + Gesamtsaldo sichtbar —
          // die Bordkasse-Tabelle oben zeigt Posten bewusst nicht mehr. Der
          // Posten-Saldo kommt aus den Buchungen (getItemPotBalances), nicht
          // aus dem Matrix-Soll, damit Σ = 0 und Gesamt = Summe der Töpfe.
          people={rows.map((r) => ({
            person_id: r.person_id,
            name: r.display_name,
            itemBalance: itemPot.get(r.person_id) ?? 0,
            total: r.balance,
          }))}
        />
      )}

      {tripStarted && hasPlan && (
        <PrepaymentsSummary
          tripId={id}
          poolBalances={poolBalances}
          nameById={nameById}
          planTotal={plan?.total_amount ?? 0}
          charterPaid={charterPaid}
          tripType={tripType}
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
  tripType,
}: {
  tripId: string;
  poolBalances: PrepaymentPoolBalance[];
  nameById: Map<string, string>;
  /** Gesamt-Anzahlungssumme aus dem Plan (= Preis ggü. Anbieter). */
  planTotal: number;
  /** Σ aller Anzahlungs-Überweisungen (Vorstrecker → Anbieter). */
  charterPaid: number;
  tripType: TripType;
}) {
  const vocab = tripVocab(tripType);
  // Σ Beiträge (für Header-Zeile)
  const sumSoll = poolBalances.reduce((s, p) => s + p.soll, 0);
  const sumPaid = poolBalances.reduce((s, p) => s + Math.min(p.paid, p.soll), 0);
  const sumOpen = Math.max(0, sumSoll - sumPaid);

  // Auslage: was wurde an den Anbieter überwiesen vs. Soll
  const charterSoll = planTotal;
  const charterOpen = Math.max(0, charterSoll - charterPaid);
  const charterFulfilled = charterSoll > 0 && charterOpen <= 0.005;
  // Plan vollständig beglichen = Crew hat alles zurückgezahlt UND der Anbieter
  // ist voll bezahlt (gleiche Definition wie der Anzahlungs-Tab in
  // getPrepaymentNavState). Dann den Block einklappen — er ist nur noch Archiv.
  const hasObligation = sumSoll > 0.005 || charterSoll > 0.005;
  const planFulfilled = hasObligation && sumOpen <= 0.005 && charterOpen <= 0.005;

  return (
    <section className="mb-4 rounded-lg border border-rule bg-paper p-4">
      <details open={!planFulfilled} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-primary">{vocab.prepayment}</h2>
            {planFulfilled && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                <Check className="h-3 w-3" aria-hidden="true" />
                vollständig beglichen
              </span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-soft transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>

      <div className="mb-2 mt-3 flex items-baseline justify-end gap-2">
        <Link className="text-xs text-primary hover:underline" href={`/trips/${tripId}/prepayments`}>
          Details →
        </Link>
      </div>

      {/* Block 1: Crewbeiträge */}
      <p className="mb-2 text-xs uppercase tracking-wide text-ink-soft">{vocab.contributions}</p>
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
            // „overpaid" MUSS vor der 0-Soll-Abkürzung stehen: wer kein Soll
            // hat, aber trotzdem in den Pool gezahlt hat, ist überzahlt und
            // nicht „bezahlt" (echte Auslöser: 0-€-Soll bei „individuell",
            // Zahlung vor dem Speichern des Plans, gelöschte 0-€-Obligation).
            // In der alten Reihenfolge tarnte diese Abkürzung jedes fehlende
            // Soll als grünes „bezahlt" — genau deshalb fiel der RLS-Fund
            // (Crew sah fremdes Soll als 0) nicht als Fehler auf.
            const status: "open" | "partial" | "paid" | "overpaid" =
              overpaid ? "overpaid" :
              p.soll <= 0.005 ? "paid" :
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

      {/* Block 2: Charterauslage (Vorstrecker → Vercharterer) */}
      {charterSoll > 0 && (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-ink-soft">An {vocab.provider} überwiesen</p>
          <div className="flex items-center justify-between gap-3 rounded-md bg-paper-soft px-3 py-2 text-sm">
            <span className="font-medium">{vocab.prepayment}</span>
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
              Noch <strong className="text-danger">{formatEuro(charterOpen)}</strong> an den Anbieter zu überweisen.
            </p>
          )}
        </div>
      )}
      </details>
    </section>
  );
}

/**
 * Erklärt die Töpfe der Bilanz — nur die, die es im Törn wirklich gibt.
 * Reine Funktion (Text), damit er in Server-Komponente und Test gleich ist.
 */
function balanceExplanation(tripType: TripType, hasPlan: boolean, hasItems: boolean): string {
  const vocab = tripVocab(tripType);
  const other = tripType === "other";
  const parts: string[] = [];
  if (hasPlan) {
    parts.push(
      other
        ? "„Anzahlung“ ist das Geld für die Reise, das vorab an den Anbieter gezahlt wird."
        : "„Anzahlung“ ist das Geld für die Yachtcharter, das vorab an den Anbieter gezahlt wird.",
    );
  }
  if (hasItems) {
    parts.push("„Weitere Zahlungen“ sind Zahlungen neben der Anzahlung, z. B. Flüge oder Bahn für die An-/Abreise.");
  }
  parts.push(
    other
      ? `„${vocab.kitty}“ sind die laufenden Kosten während der Reise (z. B. Verpflegung, Unterkunft).`
      : `„${vocab.kitty}“ sind die laufenden Kosten während des Törns (Sprit, Hafen, Essen).`,
  );
  parts.push("„Gesamt“ fasst alle Töpfe zusammen. Das ist unterm Strich dein Saldo.");
  return `Diese Bilanz hat mehrere Töpfe: ${parts.join(" ")}`;
}

/**
 * Reise-Posten: Status je Posten (Icon + Text) und je Person Posten-Saldo
 * sowie Gesamtsaldo. Der Posten-Saldo kommt aus den Buchungen
 * (getItemPotBalances), nicht aus dem Matrix-Soll — Σ = 0.
 */
function ItemsSummary({
  tripId,
  items,
  people,
  tripType,
}: {
  tripId: string;
  items: PrepaymentItemView[];
  people: { person_id: string; name: string; itemBalance: number; total: number }[];
  tripType: TripType;
}) {
  const vocab = tripVocab(tripType);
  const overpaidPersonIds = new Set(
    items.flatMap((it) => it.cells.filter((c) => c.status === "overpaid").map((c) => c.person_id)),
  );
  const fmtSigned = (n: number) => `${n > 0.005 ? "+" : n < -0.005 ? "−" : ""}${formatEuro(Math.abs(n))}`;
  const srSaldo = (name: string, n: number, pot: string) =>
    n > 0.005
      ? `${name} bekommt ${formatEuro(n)} (${pot})`
      : n < -0.005
        ? `${name} zahlt ${formatEuro(-n)} (${pot})`
        : `${name} ist ausgeglichen (${pot})`;

  return (
    <section className="mb-4 rounded-lg border border-rule bg-paper p-4" aria-labelledby="items-summary-heading">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="items-summary-heading" className="text-sm font-semibold text-primary">Weitere Zahlungen</h2>
        <Link className="inline-flex min-h-[44px] items-center text-xs text-primary hover:underline" href={`/trips/${tripId}/prepayments`}>
          Details →
        </Link>
      </div>
      <ul className="divide-y divide-rule text-sm">
        {items.map((it) => {
          const overall = itemOverallStatus(it);
          // Überzahlung geht vor „teilweise": das Geld muss zurück (M4).
          const badge: "open" | "partial" | "paid" | "overpaid" =
            overall === "complete" ? "paid" : overall === "overpaid" ? "overpaid" : it.paidTotal > 0.005 ? "partial" : "open";
          return (
            <li key={it.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-2 font-medium">
                  <CategoryIcon icon={it.category_icon} name={it.category_name} className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">{it.label}</span>
                </span>
                <span className="inline-flex items-center gap-2 text-xs text-ink-soft">
                  <StatusBadge status={badge} />
                  {ITEM_OVERALL_LABEL[overall]}
                </span>
              </div>
              <p className="mt-1 pl-6 text-xs tabular-nums text-ink-soft">
                {vocab.crew}: {formatEuro(groupPaidCapped(it.cells))} von {formatEuro(it.sollTotal)} · Anbieter:{" "}
                {formatEuro(it.providerPaid)} von {formatEuro(it.total_amount)}
                {it.overpaidTotal > 0.005 && <> · <strong className="text-danger">{formatEuro(it.overpaidTotal)} zu viel bezahlt</strong></>}
              </p>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 overflow-hidden rounded-md border border-rule">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Saldo pro Person: erst nur der Topf „Weitere Zahlungen“, dann Gesamt aus allen Töpfen. Positive Beträge bekommen
            Geld zurück, negative zahlen nach.
          </caption>
          <thead className="bg-paper-soft text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Person</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Weitere Zahlungen</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Gesamt</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.person_id} className="border-t border-rule">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {p.name}
                  {overpaidPersonIds.has(p.person_id) && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-danger">
                      <StatusBadge status="overpaid" /> überzahlt
                    </span>
                  )}
                </th>
                <td className={`px-3 py-2 text-right tabular-nums ${p.itemBalance > 0.005 ? "text-success" : p.itemBalance < -0.005 ? "text-danger" : "text-ink-soft"}`}>
                  <span className="sr-only">{srSaldo(p.name, p.itemBalance, "Weitere Zahlungen")}</span>
                  <span aria-hidden>{fmtSigned(p.itemBalance)}</span>
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${p.total > 0.005 ? "text-success" : p.total < -0.005 ? "text-danger" : "text-ink-soft"}`}>
                  <span className="sr-only">{srSaldo(p.name, p.total, "Gesamt")}</span>
                  <span aria-hidden>{fmtSigned(p.total)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        „Weitere Zahlungen“ enthält nur deren Buchungen — die Bordkasse-Tabelle oben zählt sie nicht mit. „Gesamt“ ist die
        Summe aus allen Töpfen.
      </p>
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

function BordkasseTable({ rows, sum, hasPlan, tripType }: { rows: BalanceRow[]; sum: number; hasPlan: boolean; tripType: TripType }) {
  const vocab = tripVocab(tripType);
  return (
    <>
      <h2 className="mb-2 text-sm font-semibold text-primary">
        {hasPlan ? `${vocab.kitty} — laufende ${vocab.trip}kosten` : "Bilanz"}
      </h2>
      <div className="overflow-hidden rounded-md border border-rule bg-paper">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Bilanz der {vocab.crew}: Saldo pro Person. Positive Beträge bekommen Geld zurück, negative zahlen nach.
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
          ⚠️ Saldosumme ist {formatEuro(sum)} statt 0. Das könnte ein Rundungsfehler oder Datenproblem sein.
        </p>
      )}

      <p className="mb-4 mt-4 text-xs text-ink-soft">
        Grün = bekommt Geld zurück. Rot = muss noch zahlen. Saldosumme sollte 0 € sein.
      </p>
    </>
  );
}
