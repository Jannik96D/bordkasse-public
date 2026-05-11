"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDropdownPosition } from "@/lib/hooks/use-dropdown-position";

type Option = { id: string; name: string };

interface PersonSelectProps {
  name: string;
  options: Option[];
  /** Zusätzliche Option vor der Personen-Liste, z. B. { value: "ALL", label: "Alle (...)" }. */
  extraOption?: { value: string; label: string };
  defaultValue?: string;
  placeholder?: string;
  /** Wenn true, wird der Trigger rot umrandet (Validierungs-Fehler). */
  invalid?: boolean;
  /** Person-ID des aktuellen Users — bekommt "(du)" als dezenten Marker. */
  currentUserId?: string;
}

export function PersonSelect({
  name,
  options,
  extraOption,
  defaultValue = "",
  placeholder = "— Person wählen —",
  invalid = false,
  currentUserId,
}: PersonSelectProps) {
  const allOptions: Option[] = extraOption
    ? [{ id: extraOption.value, name: extraOption.label }, ...options]
    : options;

  const initial = allOptions.find((o) => o.id === defaultValue) ?? null;
  const [selected, setSelected] = useState<Option | null>(initial);
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

  const pick = (o: Option) => {
    setSelected(o);
    setOpen(false);
  };

  const label = (o: Option) =>
    currentUserId && o.id === currentUserId ? `${o.name} (du)` : o.name;

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
        <span className="min-w-0 truncate">
          {selected ? (
            label(selected)
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
                <span className="truncate">{label(o)}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
