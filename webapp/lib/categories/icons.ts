/**
 * Kuratierte Liste von Kategorie-Emojis. Wird im Icon-Picker und an allen
 * Stellen genutzt, wo Kategorie-Auswahl/-Anzeige gerendert wird.
 *
 * Emojis statt lucide-SVG-Icons, damit native <select>-Dropdowns sie ohne
 * Custom-Combobox-UI rendern können.
 */
export type CategoryIconOption = {
  emoji: string;
  label: string;
};

export const CATEGORY_ICONS: CategoryIconOption[] = [
  { emoji: "🛒", label: "Einkauf" },
  { emoji: "🍽️", label: "Restaurant" },
  { emoji: "☕", label: "Café" },
  { emoji: "🍺", label: "Bar / Getränke" },
  { emoji: "🍷", label: "Wein" },
  { emoji: "🍕", label: "Pizza" },
  { emoji: "🍰", label: "Süßes" },
  { emoji: "⛽", label: "Sprit" },
  { emoji: "⛵", label: "Yacht" },
  { emoji: "⚓", label: "Hafen / Liegeplatz" },
  { emoji: "🛠️", label: "Ausrüstung" },
  { emoji: "🧰", label: "Werkzeug" },
  { emoji: "🛡️", label: "Versicherung" },
  { emoji: "🎫", label: "Tickets / Eintritt" },
  { emoji: "🚌", label: "Transport" },
  { emoji: "🅿️", label: "Parken" },
  { emoji: "💊", label: "Apotheke" },
  { emoji: "🧴", label: "Hygiene" },
  { emoji: "🎁", label: "Geschenke" },
  { emoji: "🎉", label: "Party" },
  { emoji: "📦", label: "Sonstiges" },
  { emoji: "💸", label: "Allgemein" },
];

/** Default-Mapping bei System-Kategorien — synchron mit DEFAULT_CATEGORIES in lib/actions/trips.ts. */
export const DEFAULT_CATEGORY_EMOJI: Record<string, string> = {
  "Lebensmittel": "🛒",
  "Restaurant": "🍽️",
  "Sprit": "⛽",
  "Yacht": "⛵",
  "Hafen / Liegeplatz": "⚓",
  "Ausrüstung": "🛠️",
  "Versicherung": "🛡️",
  "Sonstiges": "📦",
};

/** Setzt zusammen "🛒 Lebensmittel" — für Anzeige im Listing oder native select. */
export function categoryLabel(name: string, icon: string | null | undefined): string {
  const e = icon ?? DEFAULT_CATEGORY_EMOJI[name];
  return e ? `${e} ${name}` : name;
}
