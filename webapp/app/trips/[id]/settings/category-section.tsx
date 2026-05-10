"use client";

import { useActionState, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { addCategory, removeCategory, type CatState } from "@/lib/actions/categories";
import type { CategoryRow } from "@/lib/queries/trips";
import { CATEGORY_ICONS } from "@/lib/categories/icons";
import { cn } from "@/lib/utils";

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
  const [pickedIcon, setPickedIcon] = useState<string>("📦");

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-primary">Kategorien</h2>

      <ul className="space-y-2">
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 rounded-md border border-rule bg-paper px-3 py-2"
          >
            <span className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>{c.icon ?? "•"}</span>
              <span>{c.name}</span>
            </span>
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
        <form action={formAction} className="mt-4 space-y-3 rounded-md border border-rule bg-paper-soft p-3">
          <input type="hidden" name="trip_id" value={tripId} />
          <input type="hidden" name="icon" value={pickedIcon} />

          <div>
            <label className="block text-sm font-medium">Icon</label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {CATEGORY_ICONS.map((opt) => (
                <button
                  key={opt.emoji}
                  type="button"
                  onClick={() => setPickedIcon(opt.emoji)}
                  title={opt.label}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-md border text-lg transition-colors",
                    pickedIcon === opt.emoji
                      ? "border-primary bg-navy-light/30"
                      : "border-rule bg-paper hover:border-primary/40",
                  )}
                  aria-label={opt.label}
                  aria-pressed={pickedIcon === opt.emoji}
                >
                  {opt.emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-rule bg-paper text-xl" aria-hidden>
              {pickedIcon}
            </span>
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
          </div>

          {state.status === "error" && (
            <p className="text-sm text-danger" role="alert">{state.message}</p>
          )}
        </form>
      )}
    </section>
  );
}
