"use client";

import { useTransition } from "react";
import { updateTripType } from "@/lib/actions/trips";
import type { TripType } from "@/lib/trip-vocab";

const OPTIONS: { value: TripType; label: string; hint: string }[] = [
  {
    value: "sailing",
    label: "Segeltörn",
    hint: "Segel-Begriffe (Crew, Yacht). Zählt in die Gesamtstatistik.",
  },
  {
    value: "other",
    label: "Andere Reise",
    hint: "Neutrale Begriffe (Reisegruppe, Urlaubsanzahlung). Nicht in der Gesamtstatistik.",
  },
];

/**
 * Reise-Art umschalten. Native Radios teilen sich `name=trip_type` → Browser
 * liefert korrekte Tastatur-/Pfeil-Navigation. Der Wert ist über die
 * `tripType`-Prop kontrolliert; onChange stößt die Server-Action an, die
 * revalidiert und den neuen Wert zurückspielt.
 */
export function TripTypeSection({
  tripId,
  tripType,
}: {
  tripId: string;
  tripType: TripType;
}) {
  const [pending, startTransition] = useTransition();

  const onSelect = (next: TripType) => {
    if (next === tripType || pending) return;
    startTransition(() => updateTripType(tripId, next));
  };

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-primary">Reise-Art</h2>
      <p className="text-sm text-ink-soft">
        {'„Andere Reise" nutzt neutrale Begriffe (Reisegruppe, Urlaubsanzahlung) und zählt nicht in die Gesamtstatistik.'}
      </p>
      <fieldset disabled={pending} className="mt-1 space-y-2">
        <legend className="sr-only">Reise-Art wählen</legend>
        {OPTIONS.map((o) => {
          const active = o.value === tripType;
          return (
            <label
              key={o.value}
              className={
                (active
                  ? "border-2 border-primary bg-navy-light/20"
                  : "border border-rule bg-paper hover:bg-paper-soft") +
                " flex cursor-pointer items-start gap-2.5 rounded-md px-4 py-3"
              }
            >
              <input
                type="radio"
                name="trip_type"
                value={o.value}
                checked={active}
                onChange={() => onSelect(o.value)}
                className="mt-1 h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-ink-soft">{o.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
