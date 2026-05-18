"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronRight, Tag, Users } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { formatDate, formatEuro } from "@/lib/utils";
import type { StatsSummary } from "@/lib/queries/stats";

/**
 * Klient-seitige Hülle um die Trip-Statistik mit Pill-Toggle „Pro Törn /
 * Pro Person".
 *
 * - **Pro Törn** (Default): Zahlen wie sie aus der DB kommen — Gesamtsumme,
 *   Kategorie-Summen, Tagessummen.
 * - **Pro Person**: alle Geldbeträge geteilt durch die Anzahl der
 *   Crewmitglieder. Mengen (Buchungszahl, Tagezahl) bleiben unverändert,
 *   weil sie keine Pro-Kopf-Größen sind.
 *
 * Auf gepurgten Trips ist `memberCount` ggf. 0 — dann ist der Toggle
 * deaktiviert und nur „Pro Törn" sichtbar.
 */
export function StatsView({
  tripId,
  stats,
  memberCount,
}: {
  tripId: string;
  stats: StatsSummary;
  memberCount: number;
}) {
  const canSplit = memberCount > 0;
  const [mode, setMode] = useState<"trip" | "person">("trip");
  const divider = mode === "person" ? Math.max(memberCount, 1) : 1;

  const scale = (n: number) => n / divider;
  const total = scale(stats.total);
  const avgPerDay = scale(stats.total / Math.max(stats.days, 1));
  const maxCat = Math.max(...stats.byCategory.map((c) => c.total), 1) / divider;
  const maxDay = Math.max(...stats.byDay.map((d) => d.total), 1) / divider;

  const perPersonSuffix = mode === "person" ? " / Person" : "";

  return (
    <>
      {/* Pill-Toggle */}
      <div className="mt-4">
        <div
          role="tablist"
          aria-label="Anzeige-Modus"
          className="inline-flex rounded-md border border-rule bg-paper-soft p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "trip"}
            onClick={() => setMode("trip")}
            className={
              mode === "trip"
                ? "rounded-[5px] bg-primary px-4 py-1.5 text-xs font-medium text-paper"
                : "rounded-[5px] px-4 py-1.5 text-xs font-medium text-ink-soft hover:text-ink"
            }
          >
            Pro Törn
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "person"}
            onClick={() => canSplit && setMode("person")}
            disabled={!canSplit}
            className={
              mode === "person"
                ? "rounded-[5px] bg-primary px-4 py-1.5 text-xs font-medium text-paper"
                : "rounded-[5px] px-4 py-1.5 text-xs font-medium text-ink-soft hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
            }
            title={canSplit ? undefined : "Keine Crew-Daten verfügbar (Törn gepurged?)"}
          >
            Pro Person
          </button>
        </div>
        {mode === "person" && canSplit && (
          <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-soft">
            <Users className="h-3.5 w-3.5" aria-hidden />
            Geteilt durch {memberCount} Crewmitglieder (Durchschnitt)
          </p>
        )}
      </div>

      {/* ── Summary-Karten ─────────────────────────────────────────────── */}
      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          label={mode === "person" ? "Ø pro Person" : "Gesamt"}
          value={formatEuro(total)}
        />
        <SummaryCard label="Buchungen" value={String(stats.count)} />
        <SummaryCard label="Bisherige Tage" value={String(stats.days)} />
        <SummaryCard
          label={mode === "person" ? "Ø pro Person pro Tag" : "Ø pro Tag"}
          value={formatEuro(avgPerDay)}
        />
      </section>

      {/* ── Nach Kategorie ──────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Tag className="h-4 w-4 text-primary" />
          Nach Kategorie{perPersonSuffix}
        </h2>
        <ul className="space-y-2">
          {stats.byCategory.map((c) => {
            const value = scale(c.total);
            // Prozent-Anteil bleibt unabhängig vom Modus identisch.
            const pct = (c.total / stats.total) * 100;
            const alcoholValue = scale(c.alcohol);
            return (
              <li key={c.category_id ?? "__none__"}>
                <Link
                  href={`/trips/${tripId}/transactions?q=${encodeURIComponent(c.category_name)}`}
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
                      {formatEuro(value)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(value / maxCat) * 100}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                    <span>{c.count} Buchung{c.count === 1 ? "" : "en"}</span>
                    <span>
                      {pct.toFixed(1)} %
                      {c.alcohol > 0 && (
                        <> · davon Alkohol {formatEuro(alcoholValue)}</>
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
          Nach Tag{perPersonSuffix}
        </h2>
        <ul className="space-y-2">
          {stats.byDay.map((d) => {
            const value = scale(d.total);
            const alcoholValue = scale(d.alcohol);
            return (
              <li
                key={d.date}
                className="rounded-md border border-rule bg-paper p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{formatDate(d.date)}</span>
                  <span className="shrink-0 font-mono text-sm">
                    {formatEuro(value)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-soft">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(value / maxDay) * 100}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
                  <span>{d.count} Buchung{d.count === 1 ? "" : "en"}</span>
                  {d.alcohol > 0 && <span>Alkohol {formatEuro(alcoholValue)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </>
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
