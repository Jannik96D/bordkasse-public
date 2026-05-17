"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Search, X } from "lucide-react";
import type { TransactionListRow } from "@/lib/queries/transactions";
import { CategoryIcon } from "@/components/category-icon";
import { formatDate, formatEuro } from "@/lib/utils";
import { DeleteButton } from "./delete-button";

const SPLIT_LABEL = {
  equal: "Gleichmäßig",
  on_board: "An Bord",
  time_proportional: "Zeitanteilig",
  individual: "Individuell",
} as const;

export function TransactionsList({
  tripId,
  rows,
}: {
  tripId: string;
  rows: TransactionListRow[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((t) => {
      const haystack = [
        t.description ?? "",
        t.paid_by_name ?? "",
        t.credit_from_name ?? "",
        t.credit_to_name ?? "",
        t.category_name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, rows]);

  const byDate = useMemo(() => {
    const m = new Map<string, TransactionListRow[]>();
    for (const t of filtered) {
      if (!m.has(t.date)) m.set(t.date, []);
      m.get(t.date)!.push(t);
    }
    return m;
  }, [filtered]);

  return (
    <>
      {/* Such-Feld nur einblenden, wenn es überhaupt was zu filtern gibt. */}
      {rows.length > 4 && (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Suchen (Beschreibung, Person, Kategorie)"
            aria-label="Buchungen filtern"
            className="h-11 w-full rounded-md border border-rule bg-paper pl-9 pr-9 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Suche zurücksetzen"
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule p-6 text-center text-sm text-ink-soft">
          Keine Treffer für „{query}“.
        </p>
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
                        <Link
                          href={`/trips/${tripId}/transactions/${t.id}/edit`}
                          className="rounded-md p-1 text-ink-soft hover:bg-paper-soft hover:text-primary"
                          aria-label="Buchung bearbeiten"
                          title="Bearbeiten"
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
                        <DeleteButton transactionId={t.id} tripId={tripId} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
