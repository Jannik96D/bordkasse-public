"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

type Option = { id: string; name: string };

interface PersonSelectProps {
  name: string;
  options: Option[];
  /** Zusätzliche Option vor der Personen-Liste, z. B. { value: "ALL", label: "Alle (...)" }. */
  extraOption?: { value: string; label: string };
  defaultValue?: string;
  placeholder?: string;
}

export function PersonSelect({
  name,
  options,
  extraOption,
  defaultValue = "",
  placeholder = "— Person wählen —",
}: PersonSelectProps) {
  const allOptions: Option[] = extraOption
    ? [{ id: extraOption.value, name: extraOption.label }, ...options]
    : options;

  const initial = allOptions.find((o) => o.id === defaultValue) ?? null;
  const [selected, setSelected] = useState<Option | null>(initial);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const pick = (o: Option) => {
    setSelected(o);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative mt-1">
      <input type="hidden" name={name} value={selected?.id ?? ""} />

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-md border border-rule bg-paper px-3 text-left text-base outline-none",
          "focus:border-primary focus:ring-2 focus:ring-primary/20",
        )}
      >
        <span className="min-w-0 truncate">
          {selected ? (
            selected.name
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
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-rule bg-paper shadow-lg"
        >
          {allOptions.map((o) => {
            const active = selected?.id === o.id;
            return (
              <li
                key={o.id}
                role="option"
                aria-selected={active}
                onClick={() => pick(o)}
                className={cn(
                  "flex h-11 cursor-pointer items-center justify-between gap-2 px-3 text-base hover:bg-paper-soft",
                  active && "bg-paper-soft",
                )}
              >
                <span className="truncate">{o.name}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
