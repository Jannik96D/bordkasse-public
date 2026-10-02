"use client";

import { Check } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { InfoTooltip } from "@/components/info-tooltip";

export type FilterCategory = { key: string; name: string; icon: string | null };

/**
 * Mehrfachauswahl-Filter der Statistik: Kategorie-Chips (aria-pressed +
 * Check-Icon, Auswahl ist nie nur über Farbe erkennbar), „Alle"/„Keine" und
 * der Schalter „Alkoholanteil herausrechnen". Zustand liegt beim Aufrufer
 * (reiner useState, bewusst ohne Persistenz).
 */
export function CategoryFilter({
  categories,
  selected,
  onChange,
  excludeAlcohol,
  onExcludeAlcohol,
  alcoholHint,
}: {
  categories: FilterCategory[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  excludeAlcohol: boolean;
  onExcludeAlcohol: (v: boolean) => void;
  alcoholHint?: string;
}) {
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  // Nur existierende Kategorien zählen (selected kann veraltete Schlüssel tragen).
  const selectedCount = categories.filter((c) => selected.has(c.key)).length;
  const allOn = categories.every((c) => selected.has(c.key));
  const noneOn = selectedCount === 0;
  const linkBtn =
    "min-h-touch rounded-md px-2 text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline";

  return (
    <section aria-labelledby="stats-filter-heading" className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="stats-filter-heading" className="text-sm font-semibold">
          Kategorien
        </h2>
        <div className="flex">
          <button
            type="button"
            className={linkBtn}
            aria-label="Alle Kategorien auswählen"
            disabled={allOn}
            onClick={() => onChange(new Set(categories.map((c) => c.key)))}
          >
            Alle
          </button>
          <button
            type="button"
            className={linkBtn}
            aria-label="Keine Kategorie auswählen"
            disabled={noneOn}
            onClick={() => onChange(new Set())}
          >
            Keine
          </button>
        </div>
      </div>

      <div role="group" aria-label="Kategorien auswählen" className="mt-1 flex flex-wrap gap-2">
        {categories.map((c) => {
          const on = selected.has(c.key);
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(c.key)}
              className={`inline-flex min-h-touch items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                on
                  ? "bg-primary text-paper shadow-sm"
                  : "border border-rule bg-paper-soft text-ink-soft hover:text-ink"
              }`}
            >
              {on ? (
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <CategoryIcon icon={c.icon} name={c.name} className="h-4 w-4 shrink-0" />
              )}
              <span>{c.name}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          role="switch"
          id="stats-exclude-alcohol"
          aria-checked={excludeAlcohol}
          onClick={() => onExcludeAlcohol(!excludeAlcohol)}
          className="inline-flex min-h-touch items-center gap-2 rounded-md pr-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span
            aria-hidden="true"
            className={`relative h-6 w-10 shrink-0 rounded-full border border-rule transition-colors ${
              excludeAlcohol ? "bg-primary" : "bg-paper-soft"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper shadow transition-all ${
                excludeAlcohol ? "left-[18px]" : "left-0.5"
              }`}
            />
          </span>
          <span>Alkoholanteil herausrechnen</span>
        </button>
        {alcoholHint && <InfoTooltip text={alcoholHint} label="Hinweis zum Alkoholanteil" />}
      </div>

      <p className="mt-2 text-xs text-ink-soft">
        Auswahl: {selectedCount} von {categories.length} {categories.length === 1 ? "Kategorie" : "Kategorien"}
        {excludeAlcohol ? " · ohne Alkoholanteil" : ""}
      </p>
    </section>
  );
}
