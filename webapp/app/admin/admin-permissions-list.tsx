"use client";

import { useState, useTransition } from "react";
import { setCanCreateTrips } from "@/lib/actions/trips";
import { useToast } from "@/components/toast-provider";

interface PersonRow {
  id: string;
  displayName: string;
  email: string | null;
  hasLogin: boolean;
  canCreateTrips: boolean;
}

/**
 * Ein Toggle pro Person: „Darf Törns anlegen" (persons.can_create_trips,
 * Migration 0045). Optimistisches UI mit Rollback bei Fehler — analog zu
 * app/trips/[id]/debts/debt-checkbox.tsx.
 */
export function AdminPermissionsList({ persons }: { persons: PersonRow[] }) {
  const [rows, setRows] = useState(persons);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const { show } = useToast();

  const toggle = (personId: string, next: boolean) => {
    setPendingId(personId);
    setRows((prev) => prev.map((p) => (p.id === personId ? { ...p, canCreateTrips: next } : p)));
    startTransition(async () => {
      const res = await setCanCreateTrips(personId, next);
      if (!res.ok) {
        setRows((prev) => prev.map((p) => (p.id === personId ? { ...p, canCreateTrips: !next } : p)));
        show(res.message ?? "Speichern fehlgeschlagen. Bitte erneut versuchen.", { variant: "error" });
      } else {
        show(next ? "Darf jetzt eigene Törns anlegen." : "Berechtigung entzogen.", { variant: "success" });
      }
      setPendingId(null);
    });
  };

  if (rows.length === 0) {
    return <p className="mt-6 text-sm text-ink-soft">Noch keine Personen vorhanden.</p>;
  }

  return (
    <ul className="mt-6 divide-y divide-rule rounded-md border border-rule">
      {rows.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{p.displayName}</p>
            <p className="truncate text-xs text-ink-soft">
              {p.email ?? "keine E-Mail"} {!p.hasLogin && "· ohne Login"}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <span className="text-ink-soft">Darf Törns anlegen</span>
            <input
              type="checkbox"
              checked={p.canCreateTrips}
              disabled={pendingId === p.id}
              onChange={(e) => toggle(p.id, e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded border-rule disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`${p.displayName}: darf ${p.canCreateTrips ? "aktuell" : "aktuell nicht"} Törns anlegen`}
            />
          </label>
        </li>
      ))}
    </ul>
  );
}
