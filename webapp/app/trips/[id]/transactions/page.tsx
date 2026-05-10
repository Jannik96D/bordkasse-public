import { Euro } from "lucide-react";
import { listTransactions } from "@/lib/queries/transactions";
import { FabAddTransaction } from "@/components/bottom-nav";
import { CategoryIcon } from "@/components/category-icon";
import { formatDate, formatEuro } from "@/lib/utils";
import { DeleteButton } from "./delete-button";

const SPLIT_LABEL = {
  equal: "Gleichmäßig",
  on_board: "An Bord",
  time_proportional: "Zeitanteilig",
  individual: "Individuell",
} as const;

export default async function TransactionsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const txs = await listTransactions(id);

  // Gruppieren nach Datum
  const byDate = new Map<string, typeof txs>();
  for (const t of txs) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }

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
        <div className="space-y-6">
          {Array.from(byDate.entries()).map(([date, items]) => (
            <section key={date}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                {formatDate(date)}
              </h2>
              <ul className="space-y-2">
                {items.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-md border border-rule bg-paper p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {t.type === "credit" && (
                            <span className="mr-2 rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold">
                              Gutschrift
                            </span>
                          )}
                          {t.description ?? (t.type === "credit" ? "Gutschrift" : "(ohne Beschreibung)")}
                        </p>
                        <p className="mt-1 text-xs text-ink-soft">
                          {t.type === "expense" ? (
                            <>
                              <span className="font-medium text-ink">{t.paid_by_name ?? "?"}</span>
                              {" · "}
                              {t.split_type ? SPLIT_LABEL[t.split_type] : "?"}
                              {t.alcohol_amount > 0 && ` · 🍷 ${formatEuro(t.alcohol_amount)}`}
                              {t.category_name && (
                                <span className="inline-flex items-center gap-1">
                                  {" · "}
                                  <CategoryIcon
                                    icon={t.category_icon}
                                    name={t.category_name}
                                    className="h-3.5 w-3.5 text-ink-soft"
                                  />
                                  {t.category_name}
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="font-medium text-ink">
                                {t.credit_from_name ?? "?"}
                              </span>
                              {" → "}
                              <span className="font-medium text-ink">
                                {t.credit_to_name ?? "Alle"}
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-start gap-2 text-right">
                        <p className={`font-semibold ${t.type === "credit" ? "text-gold" : "text-primary"}`}>
                          {formatEuro(t.amount)}
                        </p>
                        <DeleteButton transactionId={t.id} tripId={id} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <FabAddTransaction tripId={id} />
    </main>
  );
}
