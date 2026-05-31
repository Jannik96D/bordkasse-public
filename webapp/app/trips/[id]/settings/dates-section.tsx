"use client";

import { useActionState, useState } from "react";
import { CalendarDays } from "lucide-react";
import { updateTripDates, type DateUpdateState } from "@/lib/actions/trips";
import { InfoTooltip } from "@/components/info-tooltip";

const initial: DateUpdateState = { status: "idle" };

/**
 * Erlaubt Skipper/Admin, Start- und End-Datum des Törns nachträglich zu
 * korrigieren. Erscheint nur, wenn `canEdit` true ist (Schalter im
 * Settings-Page übernommen).
 */
export function DatesSection({
  tripId,
  startDate,
  endDate,
}: {
  tripId: string;
  startDate: string;
  endDate: string;
}) {
  const [state, formAction, pending] = useActionState(updateTripDates, initial);
  const [start, setStart] = useState(startDate);
  const [end, setEnd] = useState(endDate);

  const dirty = start !== startDate || end !== endDate;

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-primary">
        <CalendarDays className="h-4 w-4" />
        {/* Titel + Info gruppiert, damit das flex-`gap-2` nicht zum
            ml-1 des Tooltips addiert (sonst doppelter Abstand vor dem i). */}
        <span>
          Törndatum
          <InfoTooltip
            text="Existierende Buchungen werden bei Datumsänderung nicht automatisch verschoben — einzelne Einträge ggf. manuell anpassen."
            label="Hinweis zu Datumsänderung"
          />
        </span>
      </h2>

      <form action={formAction} className="space-y-3 rounded-md border border-rule bg-paper p-4">
        <input type="hidden" name="trip_id" value={tripId} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="start_date" className="block text-xs font-medium">
              Start
            </label>
            <input
              id="start_date"
              name="start_date"
              type="date"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label htmlFor="end_date" className="block text-xs font-medium">
              Ende
            </label>
            <input
              id="end_date"
              name="end_date"
              type="date"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        {state.status === "error" && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}
        {state.status === "ok" && !dirty && (
          <p className="text-sm text-success" role="status">✓ Gespeichert.</p>
        )}

        <button
          type="submit"
          disabled={pending || !dirty}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
        >
          {pending ? "Speichere …" : "Daten speichern"}
        </button>
      </form>
    </section>
  );
}
