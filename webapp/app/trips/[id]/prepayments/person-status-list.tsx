"use client";

/**
 * Gemeinsame Personenliste (PR8) für den Anzahlungsplan und jede weitere
 * Zahlung: eine Zeile pro Person mit Status, „bezahlt / Soll" und dem Knopf
 * „Einzahlung erfassen" (Skipper/vorstreckende Person) bzw. „Ich habe gezahlt"
 * (Crew). Hat eine Person mehrere Raten, klappt die Zeile zu den Raten auf —
 * jede mit eigenem Status und eigenem Knopf.
 *
 * Reine Darstellung: die Zeilen kommen fertig aus `lib/prepayments/person-rows`,
 * Dialoge/Server-Actions bleiben bei der aufrufenden Karte (`onAct`).
 */

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatEuro } from "@/lib/utils";
import { ITEM_STATUS_META } from "@/lib/prepayments/item-ui";
import { isExpandable, type PersonRow, type RateRow } from "@/lib/prepayments/person-rows";
import type { ItemCellStatus } from "@/lib/calc/prepayment-item-shares";

/** Status als Symbol UND Text (nie nur Farbe). `overdue` färbt offene/teilbezahlte Beträge rot. */
export function StatusBadge({ status, overdue = false }: { status: ItemCellStatus; overdue?: boolean }) {
  const m = ITEM_STATUS_META[status];
  const late = overdue && (status === "open" || status === "underpaid");
  const label = late ? (status === "open" ? "überfällig" : `${m.label}, überfällig`) : m.label;
  const box = late ? m.box.replace(/border-(rule|primary)/, "border-danger") : m.box;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${late ? "text-danger" : m.text}`}>
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 text-sm font-bold leading-none ${box}`}
        aria-hidden="true"
      >
        {m.glyph}
      </span>
      {label}
    </span>
  );
}

function Amounts({ paid, soll }: { paid: number; soll: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-ink-soft">
      {formatEuro(paid)} / <span className="text-ink">{formatEuro(soll)}</span>
    </span>
  );
}

const ACT_BTN =
  "inline-flex min-h-[44px] items-center rounded-md border border-primary px-3 py-2 text-sm font-medium text-primary hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20";

export function PersonStatusList({
  rows,
  ariaLabel,
  actionLabel,
  onAct,
  renderExtras,
  alwaysExpanded = false,
  emptyText = "Noch keine Sollbeträge hinterlegt.",
  contextLabel,
}: {
  rows: PersonRow[];
  ariaLabel: string;
  /** „Einzahlung erfassen" oder „Ich habe gezahlt". */
  actionLabel: string;
  /** `rateKey` gesetzt = Knopf einer einzelnen Rate; sonst Knopf der Personenzeile. Ohne `onAct` keine Knöpfe. */
  onAct?: (personKey: string, rateKey?: string) => void;
  /** Zusatzknöpfe je Person (Erinnerung, WhatsApp). */
  renderExtras?: (row: PersonRow) => ReactNode;
  /** Crew-Sicht (nur die eigene Zeile): Raten immer sichtbar, ohne Auf-/Zuklappen. */
  alwaysExpanded?: boolean;
  emptyText?: string;
  /** Wofür gezahlt wird („Flüge", „Yachtanzahlung") — nur für Screenreader-Beschriftung der Knöpfe. */
  contextLabel?: string;
}) {
  const baseId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const ctx = contextLabel ? `, ${contextLabel}` : "";

  return (
    <ul className="divide-y divide-rule rounded-md border border-rule text-sm" aria-label={ariaLabel}>
      {rows.map((row) => {
        const hasRates = isExpandable(row);
        const expandable = hasRates && !alwaysExpanded;
        const isOpen = hasRates && (alwaysExpanded || expanded.has(row.key));
        const panelId = `${baseId}-${row.key}`;
        const nameNode = (
          <>
            <span className="min-w-0 break-words font-medium">{row.name}</span>
            {row.badge && (
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                {row.badge}
              </span>
            )}
          </>
        );
        return (
          <li key={row.key}>
            {/* Zeile 1: Name · Betrag; Zeile 2: Status · Aktionen — bleibt auf 375 px lesbar */}
            <div className="px-3 py-2 sm:flex sm:items-center sm:gap-3">
              <div className="flex items-start justify-between gap-3 sm:contents">
                {expandable ? (
                  <button
                    type="button"
                    onClick={() => toggle(row.key)}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? panelId : undefined}
                    className="-my-1 flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 text-left sm:order-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    )}
                    {nameNode}
                    <span className="sr-only">{isOpen ? " — Raten ausblenden" : " — Raten anzeigen"}</span>
                  </button>
                ) : (
                  <span className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 py-1 sm:order-1">{nameNode}</span>
                )}
                <span className="flex min-h-[44px] items-center sm:order-3">
                  <Amounts paid={row.paid} soll={row.soll} />
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pb-1 sm:contents">
                <span className="sm:order-2 sm:w-60 sm:shrink-0"><StatusBadge status={row.status} overdue={row.overdue} /></span>
                <div className="flex flex-wrap items-center gap-2 sm:order-4 sm:justify-end">
                  {onAct && row.actionable && !isOpen && (
                    <button
                      type="button"
                      onClick={() => onAct(row.key)}
                      aria-label={`${actionLabel}: ${row.name}${ctx}, offen ${formatEuro(row.open)}`}
                      className={ACT_BTN}
                    >
                      {actionLabel}
                    </button>
                  )}
                  {renderExtras?.(row)}
                </div>
              </div>
            </div>
            {isOpen && (
              <ul id={panelId} className="divide-y divide-rule border-t border-rule bg-paper-soft/60" aria-label={`Raten von ${row.name}`}>
                {row.rates.map((rate) => (
                  <RateLine
                    key={rate.key}
                    rate={rate}
                    personName={row.name}
                    actionLabel={actionLabel}
                    ctx={ctx}
                    onAct={onAct ? () => onAct(row.key, rate.key) : undefined}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {rows.length === 0 && <li className="px-3 py-3 text-ink-soft">{emptyText}</li>}
    </ul>
  );
}

function RateLine({
  rate,
  personName,
  actionLabel,
  ctx,
  onAct,
}: {
  rate: RateRow;
  personName: string;
  actionLabel: string;
  ctx: string;
  onAct?: () => void;
}) {
  return (
    <li className="py-2 pl-9 pr-3 sm:flex sm:items-center sm:gap-3">
      <div className="flex items-start justify-between gap-3 sm:contents">
        <span className="min-w-0 flex-1 sm:order-1">
          <span className="block break-words font-medium">{rate.label}</span>
          <span className="block text-xs text-ink-soft">{rate.detail}</span>
        </span>
        <span className="sm:order-3">
          <Amounts paid={rate.paid} soll={rate.soll} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:contents">
        <span className="sm:order-2 sm:w-60 sm:shrink-0"><StatusBadge status={rate.status} overdue={rate.overdue} /></span>
        <span className="sm:order-4 sm:flex sm:justify-end">
          {onAct && rate.actionable && (
            <button
              type="button"
              onClick={onAct}
              aria-label={`${actionLabel}: ${personName}, ${rate.label}${ctx}, offen ${formatEuro(rate.open)}`}
              className={ACT_BTN}
            >
              {actionLabel}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
