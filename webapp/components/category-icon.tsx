import { createElement } from "react";
import { getCategoryIcon } from "@/lib/categories/icons";

export function CategoryIcon({
  icon,
  className = "h-4 w-4 text-primary",
}: {
  icon: string | null | undefined;
  className?: string;
}) {
  return createElement(getCategoryIcon(icon), { className, "aria-hidden": true });
}
