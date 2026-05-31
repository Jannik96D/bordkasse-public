"use client";

import { useActionState, useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import {
  addCategory,
  removeCategory,
  setCategoryIcon,
  type CatState,
} from "@/lib/actions/categories";
import type { CategoryRow } from "@/lib/queries/trips";
import { CategoryIcon } from "@/components/category-icon";
import { IconPicker } from "@/components/icon-picker";
import {
  iconForCategoryName,
  isCategoryIconName,
  type CategoryIconName,
} from "@/lib/categories/icons";
import { useConfirm } from "@/components/confirm-dialog";

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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const handlePick = (categoryId: string, icon: CategoryIconName) => {
    startTransition(() => {
      setCategoryIcon(categoryId, icon, tripId);
    });
  };

  const handleRemove = async (c: CategoryRow) => {
    const ok = await confirm({
      title: `Kategorie „${c.name}" löschen?`,
      body: "Die Kategorie wird aus der Auswahl entfernt. Bestehende Buchungen behalten ihren Eintrag.",
      confirmLabel: "Löschen",
      danger: true,
    });
    if (!ok) return;
    startTransition(() => {
      removeCategory(c.id, tripId);
    });
  };

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-primary">Kategorien</h2>

      <ul className="space-y-2">
        {categories.map((c) => {
          const expanded = expandedId === c.id;
          const currentIcon: CategoryIconName = isCategoryIconName(c.icon)
            ? c.icon
            : iconForCategoryName(c.name);
          return (
            <li key={c.id} className="rounded-md border border-rule bg-paper">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="flex flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                    aria-label={`Icon für ${c.name} ändern`}
                  >
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rule">
                      <CategoryIcon icon={c.icon} name={c.name} className="h-4 w-4 text-primary" />
                    </span>
                    <span className="flex-1">{c.name}</span>
                    {expanded ? (
                      <ChevronUp className="h-4 w-4 text-ink-soft" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-ink-soft" />
                    )}
                  </button>
                ) : (
                  <div className="flex flex-1 items-center gap-2">
                    <CategoryIcon icon={c.icon} name={c.name} className="h-5 w-5 text-primary" />
                    <span>{c.name}</span>
                  </div>
                )}
                {canEdit && (
                  <button
                    onClick={() => handleRemove(c)}
                    className="text-ink-soft hover:text-danger"
                    aria-label={`Kategorie ${c.name} löschen`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {canEdit && expanded && (
                <div className="border-t border-rule p-3">
                  <IconPicker
                    value={currentIcon}
                    onChange={(icon) => handlePick(c.id, icon)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canEdit && (
        <form action={formAction} className="mt-4 space-y-3 rounded-md border border-rule bg-paper-soft p-3">
          <input type="hidden" name="trip_id" value={tripId} />

          <div>
            <label className="block text-sm font-medium">Icon</label>
            <div className="mt-2">
              <IconPicker name="icon" defaultValue="Tag" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              name="name"
              required
              maxLength={40}
              placeholder="Neue Kategorie …"
              className="flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
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
      {confirmDialog}
    </section>
  );
}
