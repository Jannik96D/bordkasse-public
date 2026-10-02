// Read-Pfad der Reise-Posten (lib/queries/prepayment-items.ts, PR4a):
// Soll/bezahlt/pending je Person, Anbieter-Summe (Teilzahlungen), Abschluss-
// Status, fail-loud bei Lesefehlern.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/read-client", () => ({ readClient: vi.fn() }));

import { readClient } from "@/lib/supabase/read-client";
import { getItems, getItemProviderPaymentsPerItem, getItemPotBalances } from "@/lib/queries/prepayment-items";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const TRIP = "dddddddd-0000-4000-8000-000000000001";
const ITEM = "dddddddd-0000-4000-8000-0000000000d1";
const ITEM2 = "dddddddd-0000-4000-8000-0000000000d2";
const P = "dddddddd-0000-4000-8000-000000000002";
const A = "dddddddd-0000-4000-8000-000000000003";
const B = "dddddddd-0000-4000-8000-000000000004";

function tables(): Record<string, Row[]> {
  return {
    prepayment_items: [
      { id: ITEM, trip_id: TRIP, category_id: "cat", label: "Flüge", total_amount: 300, due_date: "2000-01-01", payee_person_id: P, split_type: "gleichmaessig", sort_order: 0 },
      { id: ITEM2, trip_id: TRIP, category_id: null, label: "Bahn", total_amount: 60, due_date: null, payee_person_id: P, split_type: "gleichmaessig", sort_order: 1 },
    ],
    prepayment_item_obligations: [
      { item_id: ITEM, trip_id: TRIP, person_id: P, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: A, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: B, amount: 100 },
      { item_id: ITEM2, trip_id: TRIP, person_id: A, amount: 60 },
    ],
    // Views als Tabellen nachgebildet (Filter macht die echte View).
    v_prepayment_item_payments: [
      { trip_id: TRIP, item_id: ITEM, person_id: P, paid_amount: 100 },
      { trip_id: TRIP, item_id: ITEM, person_id: A, paid_amount: 40 },
      { trip_id: TRIP, item_id: ITEM2, person_id: A, paid_amount: 60 },
    ],
    v_prepayment_item_pending: [
      { transaction_id: "t-p", trip_id: TRIP, item_id: ITEM, person_id: B, amount: 100, date: "2000-01-02", created_at: "2000-01-02T00:00:00Z" },
    ],
    trip_categories: [{ id: "cat", trip_id: TRIP, name: "An-/Abreise", icon: "Plane" }],
    transactions: [
      { id: "e1", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 120, deleted_at: null },
      { id: "e2", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 80, deleted_at: null },
      { id: "e3", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 999, deleted_at: "x" },
      { id: "e4", trip_id: TRIP, type: "expense", item_id: ITEM2, amount: 60, deleted_at: null },
      { id: "c1", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 500, deleted_at: null },
      { id: "e5", trip_id: TRIP, type: "expense", item_id: null, amount: 50, deleted_at: null },
    ],
  };
}

let fake: ReturnType<typeof createFakeSupabase>;
beforeEach(() => {
  fake = createFakeSupabase(tables());
  vi.mocked(readClient).mockResolvedValue(fake.client as never);
});

describe("getItemProviderPaymentsPerItem", () => {
  it("summiert Teilzahlungen, ignoriert Gelöschte, Gutschriften und Bordkasse", async () => {
    expect(await getItemProviderPaymentsPerItem(TRIP)).toEqual({ [ITEM]: 200, [ITEM2]: 60 });
  });
});

describe("getItems", () => {
  it("liefert Soll/bezahlt/pending je Person, Anbieter-Stand und Abschluss", async () => {
    const items = await getItems(TRIP);
    expect(items.map((i) => i.label)).toEqual(["Flüge", "Bahn"]);
    const flights = items[0];
    expect(flights.category_name).toBe("An-/Abreise");
    expect(flights.providerPaid).toBe(200);
    expect(flights.providerOpen).toBe(100);
    expect(flights.providerOverdue).toBe(true);
    expect(flights.sollTotal).toBe(300);
    expect(flights.paidTotal).toBe(140);
    expect(flights.pendingTotal).toBe(100);
    const status = Object.fromEntries(flights.cells.map((c) => [c.person_id, c.status]));
    expect(status).toEqual({ [P]: "paid", [A]: "underpaid", [B]: "pending" });
    expect(flights.complete).toBe(false);
    expect(flights.underpaidTotal).toBe(160);
    expect(flights.overpaidTotal).toBe(0);

    const train = items[1];
    expect(train.complete).toBe(true);
    expect(train.providerOverdue).toBe(false);
  });

  it("wirft bei einem Lesefehler statt „kein Soll“ zu liefern (fail-loud)", async () => {
    fake.failOn({ table: "prepayment_item_obligations", action: "select" });
    await expect(getItems(TRIP)).rejects.toThrow(/Posten-Sollbeträge/);
  });
});

describe("getItemPotBalances (Delta-Review 3)", () => {
  it("Empfänger zahlt 300 an den Anbieter, A zahlt 100, B nichts → P +100, A 0, B −100, Σ = 0", async () => {
    const f = createFakeSupabase({
      transactions: [
        { id: "prov", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 300, paid_by: P, deleted_at: null, confirmed_at: "x" },
        { id: "a-pays", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, credit_from: A, credit_to: P, deleted_at: null, confirmed_at: "x" },
        { id: "self", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, credit_from: P, credit_to: P, deleted_at: null, confirmed_at: "x" },
        { id: "b-pending", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, credit_from: B, credit_to: P, deleted_at: null, confirmed_at: null },
        { id: "kasse", trip_id: TRIP, type: "expense", item_id: null, amount: 50, paid_by: A, deleted_at: null, confirmed_at: "x" },
      ],
      transaction_participants: [
        { transaction_id: "prov", person_id: P, amount: 100 },
        { transaction_id: "prov", person_id: A, amount: 100 },
        { transaction_id: "prov", person_id: B, amount: 100 },
      ],
    });
    vi.mocked(readClient).mockResolvedValue(f.client as never);
    const m = await getItemPotBalances(TRIP);
    expect(m.get(P)).toBe(100);
    expect(m.get(A) ?? 0).toBe(0);
    expect(m.get(B)).toBe(-100);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(0);
  });

  it("wirft bei einem Lesefehler", async () => {
    const f = createFakeSupabase({});
    f.failOn({ table: "transactions", action: "select" });
    vi.mocked(readClient).mockResolvedValue(f.client as never);
    await expect(getItemPotBalances(TRIP)).rejects.toThrow(/Posten-Buchungen/);
  });
});

describe("Bilanz-Views fail-loud (Delta-Review 4)", () => {
  it("getBalances / getBordkasseOnlyBalances werfen bei einem Lesefehler statt [] zu liefern", async () => {
    const { getBalances, getBordkasseOnlyBalances } = await import("@/lib/queries/balances");
    const f = createFakeSupabase({});
    f.failOn({ table: "v_balances", action: "select" });
    f.failOn({ table: "v_balances_bordkasse_only", action: "select" });
    vi.mocked(readClient).mockResolvedValue(f.client as never);
    await expect(getBalances(TRIP)).rejects.toThrow(/v_balances/);
    await expect(getBordkasseOnlyBalances(TRIP)).rejects.toThrow(/v_balances_bordkasse_only/);
  });
});
