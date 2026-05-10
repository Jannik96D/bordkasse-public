"use client";

import { useState } from "react";
import {
  CATEGORY_ICONS,
  isCategoryIconName,
  type CategoryIconName,
} from "@/lib/categories/icons";
import { cn } from "@/lib/utils";

interface IconPickerProps {
  /** Kontrollierter Wert (extern gesteuert). */
  value?: CategoryIconName;
  /** Callback bei Auswahl (z.B. Server-Action triggern). */
  onChange?: (icon: CategoryIconName) => void;
  /** Initialwert für die unkontrollierte Variante (Forms via Hidden-Input). */
  defaultValue?: CategoryIconName;
  /** Wenn gesetzt, wird ein Hidden-Input mit diesem `name` für FormData gerendert. */
  name?: string;
  /** Kompaktere Variante (kleinere Buttons). */
  size?: "default" | "compact";
}

export function IconPicker({
  value,
  onChange,
  defaultValue = "Tag",
  name,
  size = "default",
}: IconPickerProps) {
  const isControlled = value !== undefined;
  const initial: CategoryIconName = isCategoryIconName(defaultValue) ? defaultValue : "Tag";
  const [internal, setInternal] = useState<CategoryIconName>(initial);
  const current: CategoryIconName = isControlled ? value : internal;

  const handlePick = (icon: CategoryIconName) => {
    if (!isControlled) setInternal(icon);
    onChange?.(icon);
  };

  const buttonSize = size === "compact" ? "h-9 w-9" : "h-10 w-10";
  const iconSize = size === "compact" ? "h-4 w-4" : "h-5 w-5";

  return (
    <div>
      {name && <input type="hidden" name={name} value={current} />}
      <div
        role="radiogroup"
        aria-label="Icon wählen"
        className="grid grid-cols-7 gap-1.5 sm:grid-cols-8"
      >
        {CATEGORY_ICONS.map(({ name: iconName, label, Icon }) => {
          const active = current === iconName;
          return (
            <button
              key={iconName}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label}
              title={label}
              onClick={() => handlePick(iconName)}
              className={cn(
                "inline-flex items-center justify-center rounded-md border transition-colors",
                buttonSize,
                active
                  ? "border-primary bg-paper ring-2 ring-primary/30"
                  : "border-rule bg-paper hover:border-primary/50",
              )}
            >
              <Icon className={cn(iconSize, "text-primary")} aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
