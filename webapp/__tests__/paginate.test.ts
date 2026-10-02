import { describe, expect, it } from "vitest";
import { fetchAllRows, PAGE_SIZE } from "@/lib/queries/paginate";

const make = (n: number, start = 0) => Array.from({ length: n }, (_, i) => start + i);

describe("fetchAllRows", () => {
  it("holt eine weitere (leere) Seite, wenn die erste exakt PAGE_SIZE Zeilen hat", async () => {
    const calls: [number, number][] = [];
    const rows = await fetchAllRows<number>(async (from, to) => {
      calls.push([from, to]);
      return { data: from === 0 ? make(PAGE_SIZE) : [], error: null };
    });
    expect(rows).toHaveLength(PAGE_SIZE);
    expect(calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("verkettet mehrere Seiten", async () => {
    const rows = await fetchAllRows<number>(async (from) => ({
      data: from === 0 ? make(PAGE_SIZE) : make(5, PAGE_SIZE),
      error: null,
    }));
    expect(rows).toHaveLength(PAGE_SIZE + 5);
  });

  it("wirft bei einer Fehlerseite statt Teilergebnis zu liefern", async () => {
    await expect(
      fetchAllRows<number>(async (from) =>
        from === 0 ? { data: make(PAGE_SIZE), error: null } : { data: null, error: { message: "x" } },
      ),
    ).rejects.toThrow();
  });
});
