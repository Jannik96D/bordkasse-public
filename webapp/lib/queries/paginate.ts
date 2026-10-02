/**
 * PostgREST begrenzt eine Antwort standardmäßig auf 1000 Zeilen. Dieser
 * Helfer holt eine Abfrage seitenweise per `.range()`, bis eine Seite
 * kürzer als die Seitengröße ist. Die Abfrage MUSS eine stabile Sortierung
 * tragen (sonst können Zeilen zwischen Seiten doppelt/gar nicht auftauchen).
 *
 * Gibt `null` bei einem Fehler zurück (Aufrufer entscheiden über Fallback).
 */
export const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[] | null> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error || !data) return null;
    all.push(...data);
    if (data.length < PAGE_SIZE) return all;
  }
}
