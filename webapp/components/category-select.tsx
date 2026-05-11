"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { cn } from "@/lib/utils";
import { useDropdownPosition } from "@/lib/hooks/use-dropdown-position";

type Category = { id: string; name: string; icon: string | null };

interface CategorySelectProps {
  name: string;
  categories: Category[];
  defaultCategoryId?: string;
  placeholder?: string;
  invalid?: boolean;
}

export function CategorySelect({
  name,
  categories,
  defaultCategoryId,
  placeholder = "— Keine —",
  invalid = false,
}: CategorySelectProps) {
  const initial = defaultCategoryId
    ? categories.find((c) => c.id === defaultCategoryId) ?? null
    : null;
  const [selected, setSelected] = useState<Category | null>(initial);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { direction, maxHeight } = useDropdownPosition(triggerRef, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (c: Category | null) => {
    setSelected(c);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative mt-1">
      <input type="hidden" name={name} value={selected?.id ?? ""} />

      <button
        ref={triggerRef}
        id={name}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-md border bg-paper px-3 text-left text-base outline-none",
          invalid
            ? "border-danger ring-2 ring-danger/20"
            : "border-rule focus:border-primary focus:ring-2 focus:ring-primary/20",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <CategoryIcon icon={selected.icon} className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">{selected.name}</span>
            </>
          ) : (
            <span className="text-ink-soft">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-ink-soft transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <ul
          role="listbox"
          style={{ maxHeight }}
          className={cn(
            "absolute z-30 w-full overflow-auto rounded-md border border-rule bg-paper shadow-lg",
            direction === "down" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          <li
            role="option"
            aria-selected={selected === null}
            onClick={() => pick(null)}
            className={cn(
              "flex h-11 cursor-pointer items-center justify-between gap-2 px-3 text-base text-ink-soft hover:bg-paper-soft",
              selected === null && "bg-paper-soft",
            )}
          >
            <span>{placeholder}</span>
            {selected === null && <Check className="h-4 w-4 text-primary" aria-hidden />}
          </li>
          {categories.map((c) => {
            const active = selected?.id === c.id;
            return (
              <li
                key={c.id}
                role="option"
                aria-selected={active}
                onClick={() => pick(c)}
                className={cn(
                  "flex h-11 cursor-pointer items-center justify-between gap-2 px-3 text-base hover:bg-paper-soft",
                  active && "bg-paper-soft",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <CategoryIcon icon={c.icon} className="h-5 w-5 shrink-0 text-primary" />
                  <span className="truncate">{c.name}</span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
