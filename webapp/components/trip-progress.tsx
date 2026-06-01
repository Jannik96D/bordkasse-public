"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, Circle, Clock, Compass, Loader2 } from "lucide-react";
import type { ItemStatus, ProgressItem, TripProgress as TripProgressData } from "@/lib/calc/trip-progress";
import { setChecklistCollapsed, setDepositSettled } from "@/lib/actions/trip-checklist";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ItemStatus, string> = {
  done: "erledigt",
  open: "offen",
  not_yet: "noch nicht dran",
};

/**
 * "Dein Törn im Überblick" — Fortschritts-Spiegel über den ganzen Törn.
 * Nur für Skipper/Co-Skipper/Admin gerendert (Sichtbarkeit entscheidet die
 * Trip-Page). Alle Status sind abgeleitet (computeTripProgress), hier wird
 * nur dargestellt + das Minimieren persistiert.
 */
export function TripProgress({
  tripId,
  progress,
  canCollapse,
  collapsed,
}: {
  tripId: string;
  progress: TripProgressData;
  /** false = Pure Admin ohne Member-Row → Minimieren nicht persistierbar. */
  canCollapse: boolean;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [pending, startTransition] = useTransition();

  const pct =
    progress.totalCount === 0
      ? 0
      : Math.round((progress.doneCount / progress.totalCount) * 100);

  function toggleCard() {
    const next = !open;
    setOpen(next);
    if (canCollapse) {
      startTransition(() => setChecklistCollapsed(tripId, !next));
    }
  }

  // Alles erledigt → kompakte Abschluss-Zeile statt voller Karte.
  if (progress.allDone) {
    return (
      <section className="mb-4 flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <p className="text-sm">
          <span className="font-medium text-success">Törn abgeschlossen</span>
          <span className="block text-ink-soft">
            Alle Schritte erledigt. Die Daten werden 30 Tage nach Törn-Ende
            automatisch gelöscht.
          </span>
        </p>
      </section>
    );
  }

  return (
    <section className="mb-4 rounded-lg border border-rule bg-paper p-4">
      <div className="flex items-center gap-3">
        <Compass className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink">Dein Törn im Überblick</h2>
          <p className="text-xs text-ink-soft">
            {progress.doneCount} von {progress.totalCount} erledigt
          </p>
        </div>
        <button
          type="button"
          onClick={toggleCard}
          disabled={pending}
          aria-expanded={open}
          className="inline-flex h-touch min-w-touch items-center justify-center rounded-md px-2 text-sm font-medium text-primary hover:bg-navy-light/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60"
        >
          {open ? "Minimieren" : "Anzeigen"}
          <ChevronDown
            className={cn("ml-1 h-4 w-4 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        role="progressbar"
        aria-valuenow={progress.doneCount}
        aria-valuemin={0}
        aria-valuemax={progress.totalCount}
        aria-label={`Törn-Fortschritt: ${progress.doneCount} von ${progress.totalCount} Schritten erledigt`}
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-navy-light/40"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      {open && (
        <ul className="mt-4 space-y-2">
          {progress.phases.map((phase) => (
            <li key={phase.id}>
              <details
                open={phase.isCurrent}
                className="group rounded-md border border-rule/60 bg-paper-soft"
              >
                <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20">
                  {phase.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-ink-soft transition-transform group-open:rotate-180" aria-hidden="true" />
                  )}
                  <span className={cn("flex-1", phase.done && "text-ink-soft")}>
                    {phase.title}
                  </span>
                  <span className="text-xs text-ink-soft">
                    {phase.items.filter((i) => i.status === "done").length}/
                    {phase.items.length}
                  </span>
                </summary>
                <ul className="space-y-1 px-3 pb-3 pt-1">
                  {phase.items.map((item) => (
                    <ProgressRow key={item.id} tripId={tripId} item={item} />
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusIcon(status: ItemStatus) {
  if (status === "done")
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />;
  if (status === "not_yet")
    return <Clock className="h-4 w-4 shrink-0 text-ink-soft/60" aria-hidden="true" />;
  return <Circle className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />;
}

function ItemLabel({ item }: { item: ProgressItem }) {
  return (
    <span
      className={cn(
        "flex-1",
        item.status === "done" && "text-ink-soft",
        item.status === "not_yet" && "text-ink-soft/60",
      )}
    >
      {item.label}
      <span className="sr-only"> — {STATUS_LABEL[item.status]}</span>
    </span>
  );
}

/**
 * Manuell abhakbares Item (aktuell nur „Kaution verrechnet"): Checkbox, die
 * der Skipper selbst setzt — kein abgeleiteter Status. Optimistisch, mit
 * Rücksetzen bei verweigerter Berechtigung / Fehler. Vor der Törn-Phase
 * ("noch nicht dran") statisch, sonst tickbar.
 */
function ManualProgressRow({ tripId, item }: { tripId: string; item: ProgressItem }) {
  const [checked, setChecked] = useState(item.status === "done");
  const [pending, startTransition] = useTransition();

  if (item.status === "not_yet") {
    return (
      <li className="flex min-h-touch items-center gap-2 px-1 text-sm">
        {statusIcon("not_yet")}
        <ItemLabel item={item} />
      </li>
    );
  }

  function toggle() {
    const next = !checked;
    setChecked(next); // optimistisch
    startTransition(async () => {
      const res = await setDepositSettled(tripId, next);
      if (!res.ok) setChecked(!next); // zurücksetzen
    });
  }

  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={toggle}
        disabled={pending}
        className="flex min-h-touch w-full items-center gap-2 rounded-md px-1 text-left text-sm hover:bg-navy-light/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink-soft" aria-hidden="true" />
        ) : checked ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Circle className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
        )}
        <span className={cn("flex-1", checked && "text-ink-soft")}>
          {item.label}
          <span className="sr-only"> — {checked ? "erledigt" : "offen"}, zum Umschalten tippen</span>
        </span>
      </button>
    </li>
  );
}

function ProgressRow({ tripId, item }: { tripId: string; item: ProgressItem }) {
  if (item.manual) {
    return <ManualProgressRow tripId={tripId} item={item} />;
  }

  const label = <ItemLabel item={item} />;

  // Nur offene Items mit Ziel sind klickbar; erledigte/„noch nicht dran" statisch.
  if (item.status === "open" && item.href) {
    return (
      <li>
        <Link
          href={`/trips/${tripId}/${item.href}`}
          className="flex min-h-touch items-center gap-2 rounded-md px-1 text-sm text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
        >
          {statusIcon(item.status)}
          {label}
          <span aria-hidden="true">→</span>
        </Link>
      </li>
    );
  }

  return (
    <li className="flex min-h-touch items-center gap-2 px-1 text-sm">
      {statusIcon(item.status)}
      {label}
    </li>
  );
}
