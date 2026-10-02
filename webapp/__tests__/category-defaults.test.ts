import { describe, it, expect } from "vitest";
import { defaultCategoriesFor } from "@/lib/categories/defaults";
import { iconForCategoryName, isCategoryIconName } from "@/lib/categories/icons";

describe("Kategorie „An-/Abreise“", () => {
  it("bekommt das Flugzeug-Icon (exakt und in Schreibvarianten)", () => {
    for (const n of ["An-/Abreise", "An/Abreise", "An - Abreise", "Anreise", "Abreise", "Flug", "Flüge"]) {
      expect(iconForCategoryName(n)).toBe("Plane");
    }
    expect(isCategoryIconName("Plane")).toBe(true);
  });

  it("matcht keine Namen, die nur zufällig Teilstrings enthalten", () => {
    for (const n of ["Reiseversicherung", "Autobahn", "Bahnhof", "Flugplatz", "Bahn", "Reise"]) {
      expect(iconForCategoryName(n)).toBe("Tag");
    }
  });

  it("ist Default bei Segeltörn (nach Yacht) und anderer Reise", () => {
    const sailing = defaultCategoriesFor("sailing").map((c) => c.name);
    expect(sailing[sailing.indexOf("Yacht") + 1]).toBe("An-/Abreise");
    const other = defaultCategoriesFor("other").map((c) => c.name);
    expect(other).toContain("An-/Abreise");
    expect(other).toContain("Transport");
    for (const c of [...defaultCategoriesFor("sailing"), ...defaultCategoriesFor("other")]) {
      if (c.name === "An-/Abreise") expect(c.icon).toBe("Plane");
    }
  });
});
