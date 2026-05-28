import { formatEuro } from "@/lib/utils";
import type {
  PrepaymentPlan,
  Tranche,
  Obligation,
  PaymentAggregate,
} from "@/lib/queries/prepayments";

interface Props {
  plan: PrepaymentPlan | null;
  tranches: Tranche[];
  obligation: Obligation | null;
  payments: PaymentAggregate[];
}

export function CrewSelfView({ plan, tranches, obligation, payments }: Props) {
  if (!plan || tranches.length === 0 || !obligation) {
    return (
      <section className="rounded-lg border border-rule bg-paper p-5 text-center">
        <p className="text-sm text-ink-soft">
          Noch kein Anzahlungs-Plan vorhanden. Der Skipper richtet das ein.
        </p>
      </section>
    );
  }

  const paidByTranche = new Map<string, number>(
    payments.map((p) => [p.tranche_id, p.paid_amount]),
  );

  const totalSoll = obligation.total_amount;
  const totalPaid = [...paidByTranche.values()].reduce((a, b) => a + b, 0);

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-rule bg-paper p-5">
        <p className="text-sm text-ink-soft">Dein Soll insgesamt</p>
        <p className="mt-1 text-2xl font-semibold">{formatEuro(totalSoll)}</p>
        <p className="mt-2 text-sm">
          Bezahlt: <strong>{formatEuro(totalPaid)}</strong> &middot; Offen: <strong>{formatEuro(Math.max(0, totalSoll - totalPaid))}</strong>
        </p>
      </div>

      <ul className="space-y-2">
        {tranches.map((t) => {
          const trancheSoll = (totalSoll * t.percent) / 100;
          const paid = paidByTranche.get(t.id) ?? 0;
          const open = trancheSoll - paid;
          const status: "open" | "partial" | "paid" =
            paid <= 0.005 ? "open" : open <= 0.005 ? "paid" : "partial";
          const isOverdue = new Date(t.due_date) < new Date() && status !== "paid";
          return (
            <li key={t.id} className="rounded-lg border border-rule bg-paper p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-ink-soft">
                    Fällig {formatDeDate(t.due_date)} &middot; {t.percent.toFixed(0)} %
                  </p>
                </div>
                <span
                  className="text-sm font-medium"
                  aria-label={statusLabel(status, isOverdue)}
                >
                  {statusSymbol(status, isOverdue)} {formatEuro(open > 0 ? open : 0)}
                </span>
              </div>
              {t.wero_request_link && (
                <a
                  href={t.wero_request_link}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Per Wero zahlen →
                </a>
              )}
            </li>
          );
        })}
      </ul>

      {plan.wero_id && (
        <p className="rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          Wero: <strong className="text-ink">{plan.wero_id}</strong>
        </p>
      )}
    </section>
  );
}

function statusSymbol(s: "open" | "partial" | "paid", overdue: boolean): string {
  if (s === "paid") return "✓";
  if (overdue) return "⏰";
  if (s === "partial") return "◐";
  return "○";
}

function statusLabel(s: "open" | "partial" | "paid", overdue: boolean): string {
  if (s === "paid") return "bezahlt";
  if (overdue) return "überfällig";
  if (s === "partial") return "teilweise bezahlt";
  return "offen";
}

function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}
