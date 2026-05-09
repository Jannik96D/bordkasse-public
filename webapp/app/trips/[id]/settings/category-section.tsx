"use client";

import { useActionState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { addCategory, removeCategory, type CatState } from "@/lib/actions/categories";
import type { CategoryRow } from "@/lib/queries/trips";

const initial: CatState = { status: "idle" };

export function CategorySection({
  tripId,
  categories,
  canEdit,
}: {
  tripId: string;
  categories: CategoryRow[];
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(addCategory, initial);
  const [, startTransition] = useTransition();

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-primary">Kategorien</h2>

      <ul className="space-y-2">
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 rounded-md border border-rule bg-paper px-3 py-2"
          >
            <span>{c.name}</span>
            {canEdit && (
              <button
                onClick={() =>
                  startTransition(() => {
                    if (confirm(`Kategorie "${c.name}" löschen?`)) {
                      removeCategory(c.id, tripId);
                    }
                  })
                }
                className="text-ink-soft hover:text-danger"
                aria-label={`Kategorie ${c.name} löschen`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <form action={formAction} className="mt-3 flex items-center gap-2">
          <input type="hidden" name="trip_id" value={tripId} />
          <input
            type="text"
            name="name"
            required
            maxLength={40}
            placeholder="Neue Kategorie …"
            className="flex-1 rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            Hinzufügen
          </button>
        </form>
      )}

      {state.status === "error" && (
        <p className="mt-2 text-sm text-danger" role="alert">{state.message}</p>
      )}
    </section>
  );
}
