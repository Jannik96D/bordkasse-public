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

/** Kommentare entfernen (Block + Zeile; „://“ in URLs bleibt unangetastet). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

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
  // Durchkopplungs-Sweep (rein deutsche Komposita als ein Wort):
  { term: "Alkohol-Anteil" },
  { term: "Anzahlungs-Plan" },
  { term: "Anzahlungs-Tranche" },
  { term: "Personen-Bezug" },
  { term: "Selbst-Verrechnung" },
  { term: "Gesamt-Statistik" },
  { term: "Crew-Daten" },
  // Grenzfälle, die zusammengezogen wurden:
  { term: "Werbe-Cookies" },
  { term: "Seiten-Cache" },
  { term: "Sichtbarkeits-Marker" },
  { term: "Server-Log" },
  { term: "Offline-Nutzung" },
  { term: "Selbst-Service" },
  { term: "Live-Vorschau" },
  { term: "Live-Auswertung" },
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

  it("Anbieter heißt in Nutzertexten einheitlich „Anbieter“, nicht Vercharterer/Charteragentur", () => {
    // PR7: eine Rolle, ein Wort — für Anzahlungsplan UND weitere Zahlungen,
    // für beide Reise-Typen. Das Vokabular liefert die Quelle.
    const vocab = stripComments(readFileSync(resolve(here, "../lib/trip-vocab.ts"), "utf8"));
    expect(vocab).toContain('provider: "Anbieter"');
    expect(vocab).not.toContain("Vercharterer");
    expect(vocab).not.toContain("Charteragentur");
    const hits: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/Vercharterer|Charteragentur|Fluggesellschaft/.test(code)) hits.push(rel(file));
    }
    expect(hits, `Nutzertext mit altem Anbieter-Wort in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("„Posten“ ist kein Nutzerwort mehr (app/ + lib/, ohne Kommentare)", () => {
    // PR7: Nutzer sehen „Weitere Zahlung(en)“; „Posten“ lebt nur noch als
    // interner Begriff (item / prepayment_items) in Kommentaren und Docs.
    // Gescannt wird der Code OHNE Kommentare; Bezeichner sind lowercase
    // (item, posten_soll …), das Nutzerwort ist großgeschrieben. „Einzelposten“
    // (Kleinbuchstabe, ganz anderes Wort) wird nicht erfasst.
    const hits: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bPosten/.test(code)) hits.push(rel(file));
    }
    expect(hits, `„Posten“ im Nutzertext gefunden in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("Plan-Karte und weitere Zahlungen teilen sich dieselben Karten-Bausteine", () => {
    // Gleiche Anatomie (PR7): Kopf, zwei Fortschrittsbalken, Hinweisblock
    // „Noch an Anbieter zu überweisen", Aktionsleiste Einzahlung erfassen ·
    // Crew informieren · Bearbeiten. Beide Karten importieren die Bausteine.
    const dir = resolve(here, "../app/trips/[id]/prepayments");
    for (const f of ["matrix.tsx", "items-section.tsx"]) {
      const src = readFileSync(resolve(dir, f), "utf8");
      expect(src, f).toContain("./payment-card-parts");
      expect(src, f).toContain("PaymentCardHeader");
      expect(src, f).toContain("PaymentProgress");
      expect(src, f).toContain("ProviderOpenBlock");
      expect(src, f).toContain("PaymentActionBar");
    }
    const parts = readFileSync(resolve(dir, "payment-card-parts.tsx"), "utf8");
    // Reihenfolge der Slots in der Aktionsleiste ist fix.
    expect(parts.indexOf("{record}")).toBeLessThan(parts.indexOf("{notify}"));
    expect(parts.indexOf("{notify}")).toBeLessThan(parts.indexOf("{edit}"));
  });
});
