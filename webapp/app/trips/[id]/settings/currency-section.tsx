"use client";

import { useState, useTransition } from "react";
import { updateTripCurrencies } from "@/lib/actions/trips";
import { FOREIGN_CURRENCIES } from "@/lib/rates/currencies";

// Regionen in Anzeige-Reihenfolge (nach Vorkommen in der kuratierten Liste).
const REGIONS = Array.from(new Set(FOREIGN_CURRENCIES.map((c) => c.region)));

/**
 * Fremdwährungen des Törns festlegen. Leere Auswahl = reiner Euro-Törn → in der
 * Buchungsmaske erscheint kein Währungswähler (Standardfall, unverändert).
 * Sobald ≥ 1 Währung aktiv ist, kann die Crew Buchungen in dieser Währung
 * erfassen; der Tageskurs wird beim Buchen live gezogen (offline: Kurs der
 * letzten Buchung), immer editierbar. Nur Skipper/Admin.
 */
export function CurrencySection({
  tripId,
  selected,
}: {
  tripId: string;
  selected: string[];
}) {
  const [active, setActive] = useState<Set<string>>(() => new Set(selected));
  const [pending, startTransition] = useTransition();

  const toggle = (code: string) => {
    const next = new Set(active);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setActive(next);
    startTransition(() => updateTripCurrencies(tripId, [...next]));
  };

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-primary">Fremdwährungen</h2>
      <p className="text-sm text-ink-soft">
        Gibt es auf diesem {"Törn"} Ausgaben in einer anderen Währung als Euro? Wähle sie
        hier — dann kannst du beim Buchen den Fremdbetrag eingeben, und er wird automatisch
        zum Tageskurs in Euro umgerechnet. Ohne Auswahl bleibt alles wie gewohnt in Euro.
      </p>
      <fieldset disabled={pending} className="mt-1 space-y-4">
        <legend className="sr-only">Fremdwährungen wählen</legend>
        {REGIONS.map((region) => (
          <div key={region}>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-soft">{region}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FOREIGN_CURRENCIES.filter((c) => c.region === region).map((c) => {
                const on = active.has(c.code);
                return (
                  <label
                    key={c.code}
                    className={
                      (on
                        ? "border-2 border-primary bg-navy-light/20"
                        : "border border-rule bg-paper hover:bg-paper-soft") +
                      " flex min-h-touch cursor-pointer items-center gap-2.5 rounded-md px-3 py-2"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(c.code)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">
                      <span className="font-medium tabular-nums">{c.code}</span>
                      <span className="ml-2 text-ink-soft">{c.label}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>
    </section>
  );
}
