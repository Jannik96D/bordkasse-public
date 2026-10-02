import { beforeEach, describe, expect, it, vi } from "vitest";

type Tables = Record<string, unknown[]>;
let tables: Tables = {};

vi.mock("@/lib/auth/get-current-person", () => ({
  getCurrentPerson: async () => ({ id: "p" }),
}));
vi.mock("@/lib/supabase/read-client", () => ({
  readClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ["select", "eq", "in", "is", "order"]) b[m] = chain;
      b.range = async (from: number, to: number) => ({
        data: (tables[table] ?? []).slice(from, to + 1),
        error: null,
      });
      // trips wird ohne range() awaited
      b.then = (res: (v: unknown) => unknown) => res({ data: tables[table] ?? [], error: null });
      return b;
    },
  }),
}));

import { getGlobalStats } from "@/lib/queries/global-stats";

beforeEach(() => {
  tables = {
    trips: [
      { id: "live", name: "L", start_date: "2026-05-01", end_date: "2026-05-08", retention_purged_at: null },
      { id: "old", name: "O", start_date: "2025-05-01", end_date: "2025-05-08", retention_purged_at: "2025-07-01" },
    ],
    transactions: [
      { id: "1", trip_id: "live", date: "2026-05-01", amount: "30", alcohol_amount: "30", category: { name: "Bar", icon: "x" } },
      { id: "2", trip_id: "live", date: "2026-05-02", amount: "20", alcohol_amount: "5", category: { name: " bar ", icon: null } },
      { id: "3", trip_id: "live", date: "2026-05-02", amount: "10", alcohol_amount: null, category: null },
    ],
    trip_statistics: [
      { trip_id: "old", date: "2025-05-01", category_name: "Bar", total_amount: "40", alcohol_amount: "40", count: 2 },
      { trip_id: "old", date: "2025-05-02", category_name: "Bar", total_amount: "50", alcohol_amount: "10", count: 3 },
    ],
  };
});

describe("getGlobalStats Verdichtung", () => {
  it("Live: reine Alkohol-Buchung wird je Buchung gezählt, Namen normalisiert zusammengefasst", async () => {
    const { rows } = await getGlobalStats();
    const bar = rows.find((r) => r.trip_id === "live" && r.key === "bar")!;
    expect(bar).toMatchObject({ total: 50, alcohol: 35, count: 2, pureAlcoholCount: 1, year: "2026" });
    const none = rows.find((r) => r.trip_id === "live" && r.key === "__none__")!;
    expect(none).toMatchObject({ total: 10, count: 1, pureAlcoholCount: 0 });
  });

  it("Purge: nur Zeilenebene — rein alkoholische Tagesgruppe zählt komplett als rein", async () => {
    const { rows } = await getGlobalStats();
    const bar = rows.find((r) => r.trip_id === "old")!;
    expect(bar).toMatchObject({ total: 90, count: 5, pureAlcoholCount: 2, year: "2025" });
  });
});
