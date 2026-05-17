import Link from "next/link";
import { BarChart3, CalendarDays, ChevronRight, Tag } from "lucide-react";
import { getTripStats } from "@/lib/queries/stats";
import { CategoryIcon } from "@/components/category-icon";
import { formatDate, formatEuro } from "@/lib/utils";

export default async function StatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const stats = await getTripStats(id);

  if (stats.count === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-primary">Statistik</h1>
        <div className="mt-6 rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine Ausgaben</p>
          <p className="mt-1 text-sm text-ink-soft">
            Sobald die erste Buchung erfasst ist, siehst du hier die Verteilung
            nach Kategorie und Tag.
          </p>
        </div>
      </main>
    );
  }

  const maxCat = Math.max(...stats.byCategory.map((c) => c.total), 1);
  const maxDay = Math.max(...stats.byDay.map((d) => d.total), 1);
  const avgPerDay = stats.total / Math.max(stats.days, 1);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-primary">Statistik</h1>
      <p className="mt-1 text-sm text-ink-soft">Live-Auswertung der Ausgaben.</p>

      {/* ── Summary-Karten ─────────────────────────────────────────────── */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Gesamt" value={formatEuro(stats.total)} />
        <SummaryCard label="Buchungen" value={String(stats.count)} />
        <SummaryCard label="Bisherige Tage" value={String(stats.days)} />
        <SummaryCard label="Ø pro Tag" value={formatEuro(avgPerDay)} />
      </section>

      {/* ── Nach Kategorie ──────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Tag className="h-4 w-4 text-primary" />
          Nach Kategorie
        </h2>
        <ul className="space-y-2">
          {stats.byCategory.map((c) => {
            const pct = (c.total / stats.total) * 100;
            // Drill-down: Klick auf eine Kategorie öffnet die Buchungs-Liste mit
            // dem Kategorie-Namen als Vorbelegung im Suchfeld.
            return (
              <li key={c.category_id ?? "__none__"}>
                <Link
                  href={`/trips/${id}/transactions?q=${encodeURIComponent(c.category_name)}`}
                  className="block rounded-md border border-rule bg-paper p-3 transition-colors hover:border-primary/40 hover:bg-paper-soft"
                  aria-label={`Buchungen in „${c.category_name}" anzeigen`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                      <CategoryIcon
                        icon={c.category_icon}
                        name={c.category_name}
                        className="h-4 w-4 shrink-0 text-primary"
                      />
                      <span className="truncate">{c.category_name}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-soft" aria-hidden />
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
                    <span>{c.count} Buchung{c.count === 1 ? "" : "en"}</span>
                    <span>
                      {pct.toFixed(1)} %
                      {c.alcohol > 0 && (
                        <> · davon Alkohol {formatEuro(c.alcohol)}</>
                      )}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Nach Tag ────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <CalendarDays className="h-4 w-4 text-primary" />
          Nach Tag
        </h2>
        <ul className="space-y-2">
          {stats.byDay.map((d) => (
            <li
              key={d.date}
              className="rounded-md border border-rule bg-paper p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{formatDate(d.date)}</span>
                <span className="shrink-0 font-mono text-sm">
                  {formatEuro(d.total)}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${(d.total / maxDay) * 100}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                <span>{d.count} Buchung{d.count === 1 ? "" : "en"}</span>
                {d.alcohol > 0 && <span>Alkohol {formatEuro(d.alcohol)}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-rule bg-paper p-3">
      <p className="text-xs uppercase tracking-wide text-ink-soft">{label}</p>
      <p className="mt-1 truncate font-mono text-base font-semibold text-primary">
        {value}
      </p>
    </div>
  );
}
