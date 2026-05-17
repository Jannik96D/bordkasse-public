import {
  ShoppingCart,
  Utensils,
  Coffee,
  Beer,
  Wine,
  Pizza,
  CakeSlice,
  Fuel,
  Sailboat,
  Anchor,
  Wrench,
  Hammer,
  ShieldCheck,
  Ticket,
  Bus,
  SquareParking,
  Pill,
  SprayCan,
  Gift,
  PartyPopper,
  Package,
  Banknote,
  Tag,
  type LucideIcon,
} from "lucide-react";

/**
 * Whitelist von lucide-Icon-Namen, die in der DB als `trip_categories.icon`
 * gespeichert werden dürfen. Hart codiert für Sicherheit (kein injizierbarer
 * Komponenten-Name) und konstante Bundle-Größe.
 */
export const CATEGORY_ICON_NAMES = [
  "ShoppingCart",
  "Utensils",
  "Coffee",
  "Beer",
  "Wine",
  "Pizza",
  "CakeSlice",
  "Fuel",
  "Sailboat",
  "Anchor",
  "Wrench",
  "Hammer",
  "ShieldCheck",
  "Ticket",
  "Bus",
  "SquareParking",
  "Pill",
  "SprayCan",
  "Gift",
  "PartyPopper",
  "Package",
  "Banknote",
  "Tag",
] as const;

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number];

const ICON_MAP: Record<CategoryIconName, LucideIcon> = {
  ShoppingCart,
  Utensils,
  Coffee,
  Beer,
  Wine,
  Pizza,
  CakeSlice,
  Fuel,
  Sailboat,
  Anchor,
  Wrench,
  Hammer,
  ShieldCheck,
  Ticket,
  Bus,
  SquareParking,
  Pill,
  SprayCan,
  Gift,
  PartyPopper,
  Package,
  Banknote,
  Tag,
};

const ICON_LABELS: Record<CategoryIconName, string> = {
  ShoppingCart: "Einkauf",
  Utensils: "Restaurant",
  Coffee: "Café",
  Beer: "Bar / Getränke",
  Wine: "Wein",
  Pizza: "Pizza",
  CakeSlice: "Süßes",
  Fuel: "Sprit",
  Sailboat: "Yacht",
  Anchor: "Hafen / Liegeplatz",
  Wrench: "Ausrüstung",
  Hammer: "Werkzeug",
  ShieldCheck: "Versicherung",
  Ticket: "Aktivitäten / Tickets",
  Bus: "Transport",
  SquareParking: "Parken",
  Pill: "Apotheke",
  SprayCan: "Hygiene",
  Gift: "Geschenke",
  PartyPopper: "Party",
  Package: "Sonstiges",
  Banknote: "Geld / Kaution",
  Tag: "Sonstiges",
};

/**
 * Reihenfolge der Picker-Chips — gruppiert nach Themen für bessere
 * Auffindbarkeit (Essen → Schiff → Service → Freizeit → Sonstiges).
 */
export const CATEGORY_ICONS: ReadonlyArray<{
  name: CategoryIconName;
  label: string;
  Icon: LucideIcon;
}> = [
  // Essen & Trinken
  "ShoppingCart",
  "Utensils",
  "Coffee",
  "Beer",
  "Wine",
  "Pizza",
  "CakeSlice",
  // Schiff & Werkzeug
  "Fuel",
  "Sailboat",
  "Anchor",
  "Wrench",
  "Hammer",
  // Service & Verwaltung
  "ShieldCheck",
  "Ticket",
  "Bus",
  "SquareParking",
  "Pill",
  "SprayCan",
  // Freizeit & Sonstiges
  "Gift",
  "PartyPopper",
  "Package",
  "Banknote",
  "Tag",
].map((name) => ({
  name: name as CategoryIconName,
  label: ICON_LABELS[name as CategoryIconName],
  Icon: ICON_MAP[name as CategoryIconName],
}));

export function isCategoryIconName(value: unknown): value is CategoryIconName {
  return (
    typeof value === "string" &&
    (CATEGORY_ICON_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Liefert die Lucide-Komponente für einen gespeicherten Icon-Wert.
 *
 * Resilient gegen alte Datenbestände, in denen `icon` noch Emoji-Strings
 * (vor Migration 0012) oder NULL enthält: dann wird über den Kategorie-
 * Namen ein passendes Icon geraten (z.B. „Lebensmittel" → ShoppingCart),
 * sodass die UI auch ohne durchgelaufene Migration korrekte Icons zeigt.
 */
export function getCategoryIcon(
  iconName: string | null | undefined,
  fallbackName?: string | null,
): LucideIcon {
  if (iconName && isCategoryIconName(iconName)) return ICON_MAP[iconName];
  if (fallbackName) {
    const matched = iconForCategoryName(fallbackName);
    if (matched !== "Tag") return ICON_MAP[matched];
  }
  return Tag;
}

/** Map gängiger Default-Kategorienamen → passendes Icon. */
const DEFAULT_NAME_ICON: Record<string, CategoryIconName> = {
  Lebensmittel: "ShoppingCart",
  Restaurant: "Utensils",
  "Hafen / Liegeplatz": "Anchor",
  Aktivitäten: "Ticket",
  Ausrüstung: "Wrench",
  Sprit: "Fuel",
  Yacht: "Sailboat",
  Versicherung: "ShieldCheck",
  Kaution: "Banknote",
  Sonstiges: "Package",
};

/**
 * Auto-Match für Default-System-Kategorien beim Trip-Anlegen + addCategory-
 * Fallback. Fuzzy via Regex für Custom-Namen wie "Café", "Bier", etc.
 */
export function iconForCategoryName(name: string): CategoryIconName {
  const trimmed = name.trim();
  const exact = DEFAULT_NAME_ICON[trimmed];
  if (exact) return exact;

  const patterns: Array<[RegExp, CategoryIconName]> = [
    [/^lebensmittel|einkauf$/i, "ShoppingCart"],
    [/^(restaurant|essen)$/i, "Utensils"],
    [/^(caf[eé]|kaffee)$/i, "Coffee"],
    [/^(bier|bar|getr[äa]nke)$/i, "Beer"],
    [/^wein$/i, "Wine"],
    [/^pizza$/i, "Pizza"],
    [/^(kuchen|dessert|s[üu]ßes)$/i, "CakeSlice"],
    [/^(sprit|diesel|benzin)$/i, "Fuel"],
    [/^(yacht|schiff|boot)$/i, "Sailboat"],
    [/^(hafen( ?\/ ?liegeplatz)?|liegeplatz|marina)$/i, "Anchor"],
    [/^(ausr[üu]stung)$/i, "Wrench"],
    [/^(werkzeug)$/i, "Hammer"],
    [/^versicherung$/i, "ShieldCheck"],
    [/^(ticket|tickets|eintritt|aktivit[äa]ten?)$/i, "Ticket"],
    [/^(kaution|kautionsschaden)$/i, "Banknote"],
    [/^(transport|bus|taxi)$/i, "Bus"],
    [/^(parken|parkplatz)$/i, "SquareParking"],
    [/^(apotheke|medikament)$/i, "Pill"],
    [/^(pflege|hygiene)$/i, "SprayCan"],
    [/^(geschenk|geschenke)$/i, "Gift"],
    [/^(feier|party)$/i, "PartyPopper"],
    [/^sonstiges$/i, "Package"],
    [/^(allgemein|geld)$/i, "Banknote"],
  ];
  for (const [pattern, icon] of patterns) {
    if (pattern.test(trimmed)) return icon;
  }
  return "Tag";
}
