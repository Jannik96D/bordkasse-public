"use client";

import { useState, useTransition } from "react";
import { Sailboat } from "lucide-react";
import { setCharterPrepayment } from "@/lib/actions/trips";

/**
 * Schalter "Mit Charter-Anzahlung". Steuert, ob die Anzahlungs-Items in der
 * Törn-Fortschritt-Karte erscheinen — nachträglich änderbar, falls die Charter
 * doch erst später dazukam.
 */
export function CharterSection({
  tripId,
  enabled,
}: {
  tripId: string;
  enabled: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(() => setCharterPrepayment(tripId, next));
  }

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-primary">
        <Sailboat className="h-4 w-4" />
        Charter-Anzahlung
      </h2>
      <div className="rounded-md border border-rule bg-paper p-4">
        <label htmlFor="charter-toggle" className="flex items-start gap-3">
          <input
            id="charter-toggle"
            type="checkbox"
            checked={on}
            disabled={pending}
            onChange={toggle}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-rule text-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
          <span>
            <span className="block text-sm font-medium">
              Yacht-Anzahlung vorab über die Bordkasse abwickeln
            </span>
            <span className="mt-1 block text-xs text-ink-soft">
              Blendet die Anzahlungs-Schritte in der Törn-Checkliste ein. Das
              Anzahlungs-Modul selbst bleibt unabhängig davon nutzbar.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}
