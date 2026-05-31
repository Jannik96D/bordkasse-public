/**
 * Begriffs-Konsistenz-Guard.
 *
 * In mehreren Sessions wurden zusammengesetzte Begriffe von der
 * Bindestrich- in die Ein-Wort-Schreibweise überführt (bzw. ersetzt):
 *   Törn-Datum→Törndatum, Aufteilungs-Methode→Aufteilungsmethode,
 *   Charter-Anzahlung→Charteranzahlung, Sammel-Text→Sammelnachricht,
 *   Kojen-Typ→Kojentyp, Status-Symbol→Statussymbol, Crew-Frist→Crewfrist,
 *   Charter-Frist→Charterfrist, Crew-Mitglied→Crewmitglied,
 *   Trip-Kontext→Tripkontext, Crew-Liste→Crewliste,
 *   Yacht-Anzahlung→Yachtanzahlung, Charter-Agentur→Charteranbieter,
 *   Törn-Fortschritt→Törnfortschritt (sichtbarer Text).
 *
 * Diese Ersetzungen waren reine String-/Kommentar-Swaps über viele Dateien.
 * Die typische Fehlerklasse: eine Ersetzung bleibt irgendwo unvollständig
 * oder eine alte Schreibweise wird später versehentlich wieder eingeführt.
 * Dieser Test scannt den aktiven App-Code (app/ + lib/) und schlägt fehl,
 * sobald eine alte Bindestrich-Form wieder auftaucht.
 *
 * Bewusst NICHT gescannt: supabase/migrations + docs/apps-script (eingefroren)
 * sowie __tests__ (Test-Beschreibungen dürfen die alten Begriffe als Prosa
 * nennen). Die internen Bezeichner „Törn-Fortschritt-Karte/-Checkliste"
 * bleiben in Kommentaren erlaubt (allowlist).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [resolve(here, "../app"), resolve(here, "../lib")];

function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const FILES = ROOTS.flatMap((root) => collectSources(root));

const rel = (p: string) => p.replace(/.*\/webapp\//, "webapp/");

/** Alte Schreibweise → darf in app/ + lib/ nicht (mehr) vorkommen. */
const FORBIDDEN: { term: string; allowed?: string[] }[] = [
  { term: "Törn-Datum" },
  { term: "Aufteilungs-Methode" },
  { term: "Charter-Anzahlung" },
  { term: "Sammel-Text" },
  { term: "Kojen-Typ" },
  { term: "Status-Symbol" },
  { term: "Crew-Frist" },
  { term: "Charter-Frist" },
  { term: "Crew-Mitglied" },
  { term: "Trip-Kontext" },
  { term: "Crew-Liste" },
  { term: "Yacht-Anzahlung" },
  { term: "Charter-Agentur" },
  { term: "Törn-Ende" },
  {
    // „Törnfortschritt" ist der sichtbare Begriff; die internen Karten-/
    // Checklisten-Bezeichner in Kommentaren bleiben aber erlaubt.
    term: "Törn-Fortschritt",
    allowed: ["Törn-Fortschritt-Karte", "Törn-Fortschritt-Checkliste"],
  },
];

describe("Begriffs-Konsistenz (Dehyphenierung aus den letzten Sessions)", () => {
  it.each(FORBIDDEN)("$term kommt nicht mehr in app/ + lib/ vor", ({ term, allowed }) => {
    const hits: string[] = [];
    for (const file of FILES) {
      let txt = readFileSync(file, "utf8");
      for (const ok of allowed ?? []) txt = txt.split(ok).join("");
      if (txt.includes(term)) hits.push(rel(file));
    }
    expect(
      hits,
      `Alte Schreibweise „${term}" gefunden in:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("Anzahlungs-Banner heisst 'Offene Charteranzahlungen'", () => {
    const matrix = readFileSync(
      resolve(here, "../app/trips/[id]/prepayments/matrix.tsx"),
      "utf8",
    );
    expect(matrix).toContain("Offene Charteranzahlungen");
    expect(matrix).not.toContain("deine Überweisungen");
  });
});
