import { iconForCategoryName } from "@/lib/categories/icons";

// Ausgelagert aus lib/actions/trips.ts: eine "use server"-Datei darf nur
// async-Funktionen exportieren, die Listen wären dort nicht testbar.
// Reihenfolge bewusst gewählt — siehe README.
// Crew-User-Feedback: zuerst die im Alltag häufigen (Lebensmittel, Restaurant),
// dann Hafen/Aktivitäten/Ausrüstung, dann Verbrauchs- + Verwaltungs-Sachen.
export const DEFAULT_CATEGORY_NAMES_SAILING = [
  "Lebensmittel",
  "Restaurant",
  "Hafen / Liegeplatz",
  "Aktivitäten",
  "Ausrüstung",
  "Sprit",
  "Yacht",
  "An-/Abreise",
  "Versicherung",
  "Kaution",
  "Sonstiges",
] as const;

// „Andere Reise": ohne segel-spezifische Kategorien (Yacht/Sprit/Hafen/
// Ausrüstung), dafür Unterkunft + Transport. Pro Reise frei editierbar.
export const DEFAULT_CATEGORY_NAMES_OTHER = [
  "Lebensmittel",
  "Restaurant",
  "Unterkunft",
  "Aktivitäten",
  "Transport",
  "An-/Abreise",
  "Versicherung",
  "Kaution",
  "Sonstiges",
] as const;

export function defaultCategoriesFor(tripType: "sailing" | "other") {
  const names =
    tripType === "other" ? DEFAULT_CATEGORY_NAMES_OTHER : DEFAULT_CATEGORY_NAMES_SAILING;
  return names.map((name) => ({ name, icon: iconForCategoryName(name) }));
}

