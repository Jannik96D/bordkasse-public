/**
 * PostgREST begrenzt eine Antwort standardmäßig auf 1000 Zeilen. Dieser
 * Helfer holt eine Abfrage seitenweise per `.range()`, bis eine Seite
 * kürzer als die Seitengröße ist. Die Abfrage MUSS eine stabile Sortierung
 * tragen (sonst können Zeilen zwischen Seiten doppelt/gar nicht auftauchen).
 *
 * Wirft bei einem Fehler (die Error-Boundary fängt es) — ein stiller
 * Teilstand würde falsche Summen als richtig ausgeben.
 *
 * ⚠️ PAGE_SIZE == PGRST_DB_MAX_ROWS (PostgREST-Standard 1000). Wäre das
 * Server-Limit KLEINER als PAGE_SIZE, käme jede Seite verkürzt zurück und
 * die Schleife bräche nach der ersten Seite ab. Bei geändertem Limit hier
 * mitziehen.
 */
export const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error || !data) throw new Error("Statistik konnte nicht geladen werden");
    all.push(...data);
    if (data.length < PAGE_SIZE) return all;
  }
}
