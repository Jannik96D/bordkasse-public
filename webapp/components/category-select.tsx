"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  // Logische Liste: erstes Element = "Keine" (null), dann die Kategorien
  // Damit lassen sich Listbox-Index und Pfeil-Navigation einheitlich behandeln.
  const items: (Category | null)[] = useMemo(
    () => [null, ...categories],
    [categories],
  );

  const initial = defaultCategoryId
    ? categories.find((c) => c.id === defaultCategoryId) ?? null
    : null;
  const [selected, setSelected] = useState<Category | null>(initial);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(() => {
    if (!initial) return 0;
    return items.findIndex((it) => it?.id === initial.id);
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { direction, maxHeight } = useDropdownPosition(triggerRef, open);

  // Beim Öffnen die aktive Option direkt setzen statt im Effect, um
  // cascading renders zu vermeiden.
  const openAndSyncActive = () => {
    const i = selected ? items.findIndex((it) => it?.id === selected.id) : 0;
    setActiveIdx(i >= 0 ? i : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open || activeIdx < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (c: Category | null) => {
    setSelected(c);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const last = items.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        openAndSyncActive();
      } else {
        setActiveIdx((i) => (i < last ? i + 1 : 0));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openAndSyncActive();
      } else {
        setActiveIdx((i) => (i > 0 ? i - 1 : last));
      }
    } else if (e.key === "Home") {
      if (open) {
        e.preventDefault();
        setActiveIdx(0);
      }
    } else if (e.key === "End") {
      if (open) {
        e.preventDefault();
        setActiveIdx(last);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      if (open && activeIdx >= 0 && activeIdx <= last) {
        e.preventDefault();
        pick(items[activeIdx]);
      } else if (!open) {
        e.preventDefault();
        openAndSyncActive();
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      if (open) setOpen(false);
    }
  };

  const listId = `${name}-listbox`;
  const optionId = (idx: number) => `${name}-opt-${idx}`;

  return (
    <div ref={rootRef} className="relative mt-1">
      <input type="hidden" name={name} value={selected?.id ?? ""} />

      <button
        ref={triggerRef}
        id={name}
        type="button"
        onClick={() => (open ? setOpen(false) : openAndSyncActive())}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIdx >= 0 ? optionId(activeIdx) : undefined}
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
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Kategorie"
          style={{ maxHeight }}
          className={cn(
            "absolute z-30 w-full overflow-auto rounded-md border border-rule bg-paper shadow-lg",
            direction === "down" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {items.map((c, idx) => {
            const isSelected = c === null ? selected === null : selected?.id === c.id;
            const isActive = idx === activeIdx;
            return (
              <li
                key={c?.id ?? "none"}
                id={optionId(idx)}
                data-idx={idx}
                role="option"
                aria-selected={isSelected}
                onClick={() => pick(c)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={cn(
                  "flex h-11 cursor-pointer items-center justify-between gap-2 px-3 text-base",
                  c === null && "text-ink-soft",
                  isActive ? "bg-navy-light/40" : "hover:bg-paper-soft",
                  isSelected && !isActive && "bg-paper-soft",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {c ? (
                    <>
                      <CategoryIcon icon={c.icon} className="h-5 w-5 shrink-0 text-primary" />
                      <span className="truncate">{c.name}</span>
                    </>
                  ) : (
                    <span>{placeholder}</span>
                  )}
                </span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
