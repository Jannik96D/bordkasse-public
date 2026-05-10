import { createElement } from "react";
import { getCategoryIcon } from "@/lib/categories/icons";

export function CategoryIcon({
  icon,
  name,
  className = "h-4 w-4 text-primary",
}: {
  icon: string | null | undefined;
  /** Kategorie-Name als Fallback, falls `icon` nicht in der Whitelist ist
   *  (z.B. alter Emoji-Bestand vor Migration 0012). */
  name?: string | null;
  className?: string;
}) {
  return createElement(getCategoryIcon(icon, name), { className, "aria-hidden": true });
}
