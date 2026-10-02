"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, CalendarDays, ChevronRight, Tag, Users } from "lucide-react";
import { CategoryFilter } from "@/components/category-filter";
import { CategoryIcon } from "@/components/category-icon";
import { SummaryCard } from "@/components/summary-card";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatDate, formatEuro } from "@/lib/utils";
import { applyStatsFilter, listCategories, resolveSelection } from "@/lib/calc/stats-filter";
import type { TripStatsData } from "@/lib/queries/stats";

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
 * Darüber filtert eine Mehrfachauswahl von Kategorien (Standard: alle) und
 * ein Schalter „Alkoholanteil herausrechnen" — Gesamt, Ø je Buchungstag,
 * Pro Person, Balken und Prozente werden aus genau dieser Auswahl neu
 * gerechnet (`applyStatsFilter`). Reiner useState, keine Persistenz.
 *
 * Auf gepurgten Trips ist `memberCount` ggf. 0 — dann ist der Toggle
 * deaktiviert und nur „Pro Törn" sichtbar.
 */
export function StatsView({
  tripId,
  data,
  memberCount,
}: {
  tripId: string;
  data: TripStatsData;
  memberCount: number;
}) {
  const vocab = useTripVocab();
  const canSplit = memberCount > 0;
  const [mode, setMode] = useState<"trip" | "person">("trip");
  const divider = mode === "person" ? Math.max(memberCount, 1) : 1;

  const categories = useMemo(() => listCategories(data.rows), [data.rows]);
  // Ausschlussmenge: neue Kategorien (Realtime-Refresh) sind standardmäßig dabei.
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(
    () => resolveSelection(categories.map((c) => c.key), deselected),
    [categories, deselected],
  );
  const [excludeAlcohol, setExcludeAlcohol] = useState(false);
  const stats = useMemo(
    () => applyStatsFilter(data.rows, { categories: selected, excludeAlcohol }),
    [data.rows, selected, excludeAlcohol],
  );
  const noSelection = selected.size === 0;

  const scale = (n: number) => n / divider;
  const total = scale(stats.total);
  const avgPerDay = scale(stats.avgPerDay);
  const maxCat = stats.maxCat / divider;
  const maxDay = stats.maxDay / divider;

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
            Pro {vocab.trip}
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
            title={canSplit ? undefined : `Keine Daten zur ${vocab.crew} verfügbar (${vocab.trip} gepurged?)`}
          >
            Pro Person
          </button>
        </div>
        {mode === "person" && canSplit && (
          <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-soft">
            <Users className="h-3.5 w-3.5" aria-hidden />
            Geteilt durch {memberCount} {vocab.member === "Crewmitglied" ? "Crewmitglieder" : "Mitreisende"} (Durchschnitt)
          </p>
        )}
      </div>

      <CategoryFilter
        categories={categories}
        selected={selected}
        onChange={(next) =>
          setDeselected(new Set(categories.filter((c) => !next.has(c.key)).map((c) => c.key)))
        }
        excludeAlcohol={excludeAlcohol}
        onExcludeAlcohol={setExcludeAlcohol}
        alcoholHint={
          mode === "person"
            ? "Alkohol zahlen nur die Trinkenden. Pro Person ist deshalb ein Durchschnitt über die ganze Gruppe, nicht der Betrag einer einzelnen Person."
            : "Zieht den bei der Buchung angegebenen Alkoholanteil vom Betrag ab. Reine Alkohol-Buchungen zählen dann nicht mehr mit."
        }
      />

      {/* Ergebnisbereich: Screenreader erfahren von Änderungen durch die Auswahl */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {noSelection
          ? "Keine Kategorie gewählt"
          : `Gesamt ${formatEuro(total)}${mode === "person" ? " pro Person" : ""}, ${stats.count} Buchungen`}
      </p>
      <div>
      {noSelection ? (
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
      {/* ── Summary-Karten ─────────────────────────────────────────────── */}
      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          label={mode === "person" ? "Ø pro Person" : "Gesamt"}
          value={formatEuro(total)}
          hint="Trinkgeld ist in der Statistik nicht enthalten."
        />
        <SummaryCard label="Buchungen" value={String(stats.count)} />
        <SummaryCard label="Buchungstage" value={String(stats.days)} />
        <SummaryCard
          label={mode === "person" ? "Ø je Person und Buchungstag" : "Ø je Buchungstag"}
          value={formatEuro(avgPerDay)}
          hint="Summe geteilt durch die Tage, an denen mindestens eine Buchung der Auswahl liegt — nicht durch alle Tage der Reise."
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
            // Prozent-Anteil (Basis: gefilterte Summe) ist modusunabhängig.
            const pct = c.pct;
            const alcoholValue = scale(c.alcohol);
            return (
              <li key={c.key}>
                <Link
                  href={`/trips/${tripId}/transactions?q=${encodeURIComponent(c.name)}`}
                  className="block rounded-md border border-rule bg-paper p-3 transition-colors hover:border-primary/40 hover:bg-paper-soft"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                      <CategoryIcon
                        icon={c.icon}
                        name={c.name}
                        className="h-4 w-4 shrink-0 text-primary"
                      />
                      <span className="truncate">{c.name}</span>
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
      )}
      </div>
    </>
  );
}
