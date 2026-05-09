"use client";

import { useActionState, useState, useTransition } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { inviteMember, removeMember, type MemberState } from "@/lib/actions/trip-members";
import type { TripMemberRow } from "@/lib/queries/trips";
import { formatDate } from "@/lib/utils";

const initial: MemberState = { status: "idle" };

export function CrewSection({
  tripId,
  members,
  canEdit,
  startDate,
  endDate,
}: {
  tripId: string;
  members: TripMemberRow[];
  canEdit: boolean;
  startDate: string;
  endDate: string;
}) {
  const [showForm, setShowForm] = useState(members.length === 0);
  const [state, formAction, pending] = useActionState(inviteMember, initial);
  const [, startTransition] = useTransition();

  // Auto-Hide bei Erfolg
  if (state.status === "ok" && showForm) {
    setTimeout(() => setShowForm(false), 800);
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary">Crew</h2>
        {canEdit && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            <Plus className="h-4 w-4" /> Hinzufügen
          </button>
        )}
      </div>

      {members.length === 0 && !showForm && (
        <p className="rounded-md border border-dashed border-rule p-4 text-center text-sm text-ink-soft">
          Keine Crew angelegt.
        </p>
      )}

      <ul className="space-y-2">
        {members.map((m) => (
          <li
            key={m.id}
            className="flex items-start justify-between gap-3 rounded-md border border-rule bg-paper p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {m.display_name}
                {m.is_alcoholic_effective && (
                  <span className="ml-2 rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold">
                    🍷
                  </span>
                )}
              </p>
              {m.email && <p className="text-xs text-ink-soft">{m.email}</p>}
              <p className="mt-1 text-xs text-ink-soft">
                An Bord:{" "}
                {m.on_board_from ? formatDate(m.on_board_from) : "ab Törn-Start"}
                {" – "}
                {m.on_board_to ? formatDate(m.on_board_to) : "bis Ende"}
              </p>
              {m.note && <p className="mt-1 text-xs italic text-ink-soft">„{m.note}“</p>}
            </div>
            {canEdit && (
              <button
                onClick={() =>
                  startTransition(() => {
                    if (confirm(`${m.display_name} aus der Crew entfernen?`)) {
                      removeMember(m.id, tripId);
                    }
                  })
                }
                className="text-ink-soft hover:text-danger"
                aria-label={`${m.display_name} entfernen`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {showForm && canEdit && (
        <form action={formAction} className="mt-4 space-y-3 rounded-md border border-rule bg-paper-soft p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Crew-Mitglied hinzufügen</h3>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-ink-soft hover:text-ink"
              aria-label="Abbrechen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <input type="hidden" name="trip_id" value={tripId} />

          <div>
            <label htmlFor="email" className="block text-sm font-medium">E-Mail</label>
            <input id="email" name="email" type="email" required
              placeholder="crew@example.com"
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div>
            <label htmlFor="display_name" className="block text-sm font-medium">
              Anzeigename <span className="text-ink-soft font-normal">(optional)</span>
            </label>
            <input id="display_name" name="display_name" type="text"
              placeholder="Wird aus E-Mail abgeleitet wenn leer"
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="on_board_from" className="block text-xs font-medium">
                An Bord ab
              </label>
              <input id="on_board_from" name="on_board_from" type="date"
                min={startDate} max={endDate}
                placeholder={startDate}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label htmlFor="on_board_to" className="block text-xs font-medium">
                An Bord bis
              </label>
              <input id="on_board_to" name="on_board_to" type="date"
                min={startDate} max={endDate}
                placeholder={endDate}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>

          <div>
            <label htmlFor="is_alcoholic" className="block text-sm font-medium">
              Alkohol-Trinker?
            </label>
            <select id="is_alcoholic" name="is_alcoholic"
              defaultValue=""
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">Default aus Person übernehmen</option>
              <option value="yes">Ja — bekommt Alkohol-Anteil</option>
              <option value="no">Nein — kein Alkohol-Anteil</option>
            </select>
          </div>

          <div>
            <label htmlFor="note" className="block text-sm font-medium">
              Hinweis <span className="text-ink-soft font-normal">(optional)</span>
            </label>
            <input id="note" name="note" type="text" maxLength={200}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {state.status === "error" && (
            <p className="text-sm text-danger" role="alert">{state.message}</p>
          )}
          {state.status === "ok" && (
            <p className="text-sm text-success" role="status">✓ Hinzugefügt.</p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-primary px-4 py-2 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
          >
            {pending ? "Speichere …" : "Hinzufügen"}
          </button>
        </form>
      )}
    </section>
  );
}
