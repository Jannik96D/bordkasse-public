"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Anchor, BarChart3, CalendarDays, ChevronRight, Tag } from "lucide-react";
import { CategoryFilter } from "@/components/category-filter";
import { CategoryIcon } from "@/components/category-icon";
import { SummaryCard } from "@/components/summary-card";
import { formatDate, formatEuro } from "@/lib/utils";
import { applyGlobalFilter, listCategories, resolveSelection } from "@/lib/calc/stats-filter";
import type { GlobalStatsData } from "@/lib/queries/global-stats";

/**
 * Präsentation der Cross-Trip-Statistik. Client-Component: die Kategorie-
 * Auswahl und der Alkoholanteil-Schalter rechnen Summen, „Nach Törn/Jahr",
 * Törn-Anzahl und Ø pro Törn aus den vorverdichteten Zeilen neu
 * (`applyGlobalFilter`); Törns ohne verbleibende Buchungen verschwinden.
 *
 * Vier Sections, gleiche Reihenfolge wie auf der Per-Trip-Seite:
 *   1. Summary-Karten (Gesamt, Anzahl Törns, Anzahl Buchungen, Ø pro Törn)
 *   2. Nach Kategorie (Bar-Chart)
 *   3. Nach Törn (Liste mit Drilldown zur Per-Trip-Stat)
 *   4. Nach Jahr / Saison
 */
export function GlobalStatsView({
  data,
  admin,
}: {
  data: GlobalStatsData;
  admin: boolean;
}) {
  const categories = useMemo(() => listCategories(data.rows), [data.rows]);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(
    () => resolveSelection(categories.map((c) => c.key), deselected),
    [categories, deselected],
  );
  const [excludeAlcohol, setExcludeAlcohol] = useState(false);
  const stats = useMemo(
    () => applyGlobalFilter(data.rows, data.trips, { categories: selected, excludeAlcohol }),
    [data.rows, data.trips, selected, excludeAlcohol],
  );
  const { maxCat, maxTrip, maxYear } = stats;

  return (
    <>
      <CategoryFilter
        categories={categories}
        selected={selected}
        onChange={(next) =>
          setDeselected(new Set(categories.filter((c) => !next.has(c.key)).map((c) => c.key)))
        }
        excludeAlcohol={excludeAlcohol}
        onExcludeAlcohol={setExcludeAlcohol}
        alcoholHint="Zieht den bei der Buchung angegebenen Alkoholanteil vom Betrag ab. Reine Alkohol-Buchungen zählen dann nicht mit. Trinkgeld ist in der Statistik nie enthalten."
      />

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {selected.size === 0
          ? "Keine Kategorie gewählt"
          : `Gesamt ${formatEuro(stats.total)}, ${stats.count} Buchungen`}
      </p>
      <div>
      {selected.size === 0 ? (
        <div className="mt-6 rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-10 w-10 text-ink-soft" aria-hidden />
          <p className="font-medium">Keine Kategorie gewählt</p>
          <p className="mt-1 text-sm text-ink-soft">
            Wähle oben mindestens eine Kategorie, um die Auswertung zu sehen.
          </p>
        </div>
      ) : stats.count === 0 ? (
        <div className="mt-6 rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-10 w-10 text-ink-soft" aria-hidden />
          <p className="font-medium">Nach Abzug keine Buchungen</p>
          <p className="mt-1 text-sm text-ink-soft">
            In der gewählten Auswahl bleibt nach dem Herausrechnen des Alkoholanteils nichts übrig.
          </p>
        </div>
      ) : (
      <>
      {/* ── Summary ─────────────────────────────────────────────────── */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Gesamt" value={formatEuro(stats.total)} />
        <SummaryCard label="Törns" value={String(stats.tripCount)} />
        <SummaryCard label="Buchungen" value={String(stats.count)} />
        <SummaryCard label="Ø pro Törn" value={formatEuro(stats.avgPerTrip)} />
      </section>

      {admin && (
        <p className="mt-2 text-xs text-ink-soft">
          Admin-Ansicht: aggregiert über alle Törns im System.
        </p>
      )}

      {/* ── Nach Kategorie ──────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Tag className="h-4 w-4 text-primary" />
          Nach Kategorie
        </h2>
        <ul className="space-y-2">
          {stats.byCategory.map((c) => {
            const pct = c.pct;
            return (
              <li
                key={c.key}
                className="rounded-md border border-rule bg-paper p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                    <CategoryIcon
                      icon={c.icon}
                      name={c.name}
                      className="h-4 w-4 shrink-0 text-primary"
                    />
                    <span className="truncate">{c.name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-sm">
                    {formatEuro(c.total)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(c.total / maxCat) * 100}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                  <span>
                    {c.count} Buchung{c.count === 1 ? "" : "en"}
                  </span>
                  <span>
                    {pct.toFixed(1)} %
                    {c.alcohol > 0 && <> · davon Alkohol {formatEuro(c.alcohol)}</>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Nach Törn ───────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Anchor className="h-4 w-4 text-primary" />
          Nach Törn
        </h2>
        <ul className="space-y-2">
          {stats.byTrip.map((t) => (
            <li key={t.trip_id}>
              <Link
                href={`/trips/${t.trip_id}/stats`}
                className="block rounded-md border border-rule bg-paper p-3 transition-colors hover:border-primary/40 hover:bg-paper-soft"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                    <span className="truncate">{t.name}</span>
                    {t.purged && (
                      <span className="shrink-0 rounded bg-paper-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                        anonymisiert
                      </span>
                    )}
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-ink-soft"
                      aria-hidden
                    />
                  </span>
                  <span className="shrink-0 font-mono text-sm">
                    {formatEuro(t.total)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(t.total / maxTrip) * 100}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                  <span>
                    {formatDate(t.start_date)} – {formatDate(t.end_date)}
                  </span>
                  <span>
                    {t.count} Buchung{t.count === 1 ? "" : "en"}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Nach Jahr / Saison ──────────────────────────────────────── */}
      {stats.byYear.length > 1 && (
        <section className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <CalendarDays className="h-4 w-4 text-primary" />
            Nach Jahr
          </h2>
          <ul className="space-y-2">
            {stats.byYear.map((y) => (
              <li
                key={y.year}
                className="rounded-md border border-rule bg-paper p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{y.year}</span>
                  <span className="shrink-0 font-mono text-sm">
                    {formatEuro(y.total)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(y.total / maxYear) * 100}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                  <span>
                    {y.tripCount} Törn{y.tripCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    {y.count} Buchung{y.count === 1 ? "" : "en"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      </>
      )}
      </div>
    </>
  );
}
