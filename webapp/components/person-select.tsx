"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const allOptions: Option[] = useMemo(
    () =>
      extraOption
        ? [{ id: extraOption.value, name: extraOption.label }, ...options]
        : options,
    [extraOption, options],
  );

  const initial = allOptions.find((o) => o.id === defaultValue) ?? null;
  const [selected, setSelected] = useState<Option | null>(initial);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(() => {
    const i = initial ? allOptions.findIndex((o) => o.id === initial.id) : -1;
    return i >= 0 ? i : 0;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { direction, maxHeight } = useDropdownPosition(triggerRef, open);

  // Beim Öffnen die aktive Option auf die gewählte setzen — wir lösen
  // das im Toggle/Open-Pfad selbst (kein useEffect), um cascading
  // renders zu vermeiden.
  const openAndSyncActive = () => {
    const i = selected ? allOptions.findIndex((o) => o.id === selected.id) : -1;
    setActiveIdx(i >= 0 ? i : 0);
    setOpen(true);
  };

  // Aktive Option in den Sichtbereich scrollen
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

  const pick = (o: Option) => {
    setSelected(o);
    setOpen(false);
    // Fokus zurück auf den Trigger, damit Tastatur-Flow erhalten bleibt
    triggerRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const last = allOptions.length - 1;
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
        pick(allOptions[activeIdx]);
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
      // Tab schließt das Dropdown, behält aber Fokus-Flow
      if (open) setOpen(false);
    }
  };

  const label = (o: Option) =>
    currentUserId && o.id === currentUserId ? `${o.name} (du)` : o.name;

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
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={placeholder}
          style={{ maxHeight }}
          className={cn(
            "absolute z-30 w-full overflow-auto rounded-md border border-rule bg-paper shadow-lg",
            direction === "down" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {allOptions.map((o, idx) => {
            const isSelected = selected?.id === o.id;
            const isActive = idx === activeIdx;
            return (
              <li
                key={o.id}
                id={optionId(idx)}
                data-idx={idx}
                role="option"
                aria-selected={isSelected}
                onClick={() => pick(o)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={cn(
                  "flex h-11 cursor-pointer items-center justify-between gap-2 px-3 text-base",
                  isActive ? "bg-navy-light/40" : "hover:bg-paper-soft",
                  isSelected && !isActive && "bg-paper-soft",
                )}
              >
                <span className="truncate">{label(o)}</span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
