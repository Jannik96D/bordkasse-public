import { InfoTooltip } from "@/components/info-tooltip";

/**
 * Kleine Kacheln für Statistik-Übersichten (Per-Trip + Global).
 * Geteilt zwischen `app/trips/[id]/stats/stats-view.tsx` und
 * `app/stats/global-stats-view.tsx`.
 */
export function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** Optionaler Erklärtext als ⓘ-Tooltip neben dem Label. */
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-rule bg-paper p-3">
      <p className="text-xs uppercase tracking-wide text-ink-soft">
        {label}
        {hint && <InfoTooltip text={hint} label={`Hinweis zu ${label}`} />}
      </p>
      <p className="mt-1 truncate font-mono text-base font-semibold text-primary">
        {value}
      </p>
    </div>
  );
}
