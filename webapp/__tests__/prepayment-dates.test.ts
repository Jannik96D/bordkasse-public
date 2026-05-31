/**
 * Vitest für die Anzahlungs-Datum-Helper (lib/prepayments/dates.ts).
 * Fokus: der Clamp in toCrewDueDate (Crew-Frist nie in der Vergangenheit,
 * solange die Charter-Frist aussteht — aber nie nach der Charter-Frist).
 */

import { describe, expect, it } from "vitest";
import { toCrewDueDate, addDays } from "@/lib/prepayments/dates";

describe("toCrewDueDate", () => {
  it("zieht 3 Tage von der Charter-Frist ab, wenn genug Vorlauf da ist", () => {
    expect(toCrewDueDate("2026-04-10", "2026-01-01")).toBe("2026-04-07");
  });

  it("clampt nicht in die Vergangenheit, solange die Charter-Frist aussteht", () => {
    // crewDue wäre 2026-04-07, heute ist 2026-04-08 → auf heute geklemmt.
    expect(toCrewDueDate("2026-04-10", "2026-04-08")).toBe("2026-04-08");
  });

  it("überschreitet nie die Charter-Frist (heute schon nach Charter-Frist)", () => {
    // charterDue liegt in der Vergangenheit → Crew-Frist auf charterDue gekappt.
    expect(toCrewDueDate("2026-04-10", "2026-04-20")).toBe("2026-04-10");
  });

  it("heute == Charter-Frist → Crew-Frist = Charter-Frist", () => {
    expect(toCrewDueDate("2026-04-10", "2026-04-10")).toBe("2026-04-10");
  });

  it("leere Eingabe bleibt leer", () => {
    expect(toCrewDueDate("", "2026-01-01")).toBe("");
  });
});

describe("addDays", () => {
  it("addiert Tage zeitzonenneutral", () => {
    expect(addDays("2026-04-10", 3)).toBe("2026-04-13");
    expect(addDays("2026-04-10", -3)).toBe("2026-04-07");
  });
});
