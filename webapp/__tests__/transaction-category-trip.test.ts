// Slice 8 (Sicherheitsrunde 2026-11): category_id einer Buchung muss zum Törn
// gehören — in allen drei Schreibpfaden (create, update, Outbox-Replay).
// Die DB erzwingt das zusätzlich per Composite-FK tx_category_fk (0064, pgTAP);
// hier wird der App-Check mit verständlicher Meldung geprüft.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/auth/trip-state", () => ({
  assertTripNotArchived: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/db/audit", () => ({ logAudit: vi.fn() }));

import { createExpense, updateExpense, replayPendingTransaction } from "@/lib/actions/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const TRIP_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const PERSON_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const CATEGORY_ID = "bbbbbbbb-0000-4000-8000-000000000003";
const TX_ID = "bbbbbbbb-0000-4000-8000-000000000004";

type Op = { table: string; op: string };

const EXISTING_TX = {
  created_by: PERSON_ID,
  type: "expense",
  trip_id: TRIP_ID,
  deleted_at: null,
  description: "alt",
  category_id: null,
  date: "2026-06-07",
  paid_by: PERSON_ID,
  amount: 10,
  alcohol_amount: 0,
  tip_amount: 0,
  tip_distribution: "proportional",
  split_type: "equal",
  tranche_id: null,
  item_id: null,
};

const SINGLE_ROWS: Record<string, unknown> = {
  transactions: { id: TX_ID },
  trips: { start_date: "2026-06-06", end_date: "2026-06-13", trip_type: "sailing" },
};

// Tabellengesteuerter Fake: trip_categories.maybeSingle liefert die Kategorie
// nur, wenn sie zum Törn gehört (categoryBelongs). Alles andere ist ein
// permissiver Erfolgs-Fake; Schreiboperationen werden protokolliert.
function makeFake(opts: { categoryBelongs: boolean; categoryError?: boolean }) {
  const ops: Op[] = [];
  const from = (table: string) => {
    let counting = false;
    const filters: Record<string, unknown> = {};
    const thenable = (onFulfilled: (v: unknown) => unknown) => {
      let value: unknown = { data: [], error: null };
      if (table === "trip_members") {
        value = counting
          ? { count: 2, data: null, error: null }
          : { data: [{ person_id: PERSON_ID }], error: null };
      }
      return Promise.resolve(value).then(onFulfilled);
    };
    const maybeSingle = () => {
      if (table === "trip_categories") {
        if (opts.categoryError) return Promise.resolve({ data: null, error: { message: "boom" } });
        // Die Kategorie wird NUR geliefert, wenn nach id UND trip_id des Törns gefiltert wurde.
        const hit = opts.categoryBelongs && filters.id === CATEGORY_ID && filters.trip_id === TRIP_ID;
        return Promise.resolve({ data: hit ? { id: CATEGORY_ID } : null, error: null });
      }
      if (table === "transactions") return Promise.resolve({ data: EXISTING_TX, error: null });
      if (table === "trip_members") return Promise.resolve({ data: { person_id: PERSON_ID }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    const handler: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return thenable;
        if (prop === "eq") {
          return (col: string, val: unknown) => {
            filters[col] = val;
            return proxy;
          };
        }
        if (prop === "maybeSingle") return maybeSingle;
        if (prop === "single") return () => Promise.resolve({ data: SINGLE_ROWS[table] ?? null, error: null });
        if (prop === "select") {
          return (_c?: unknown, o?: { count?: string }) => {
            if (o?.count) counting = true;
            return proxy;
          };
        }
        if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") {
          return () => {
            ops.push({ table, op: prop });
            return proxy;
          };
        }
        return () => proxy;
      },
    };
    const proxy: object = new Proxy({}, handler);
    return proxy;
  };
  return { client: { from, rpc: () => Promise.resolve({ error: null }) }, ops };
}

function expenseFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("date", "2026-06-07");
  fd.set("description", "Einkauf");
  fd.set("paid_by", PERSON_ID);
  fd.set("amount", "12,00");
  fd.set("split_type", "equal");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

const CATEGORY_MSG = "Kategorie nicht (mehr) verfügbar";
const txWrites = (ops: Op[]) => ops.filter((o) => o.table === "transactions");

beforeEach(() => {
  vi.mocked(getCurrentPerson).mockResolvedValue({ id: PERSON_ID, display_name: "Crew", email: "c@x.de" } as never);
  vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: PERSON_ID });
  vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: PERSON_ID });
});

describe("createExpense — Kategorie muss zum Törn gehören", () => {
  it("weist eine Fremd-Kategorie ab, ohne zu schreiben", async () => {
    const { client, ops } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await createExpense({ status: "idle" }, expenseFormData({ category_id: CATEGORY_ID }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain(CATEGORY_MSG);
    expect(txWrites(ops)).toHaveLength(0);
  });

  it("erlaubt eine eigene Kategorie", async () => {
    const { client, ops } = makeFake({ categoryBelongs: true });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await createExpense({ status: "idle" }, expenseFormData({ category_id: CATEGORY_ID }));
    if (res?.status === "error") expect(res.message).not.toContain(CATEGORY_MSG);
    expect(txWrites(ops).some((o) => o.op === "insert")).toBe(true);
  });

  it("erlaubt eine Buchung ganz ohne Kategorie", async () => {
    const { client, ops } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await createExpense({ status: "idle" }, expenseFormData());
    if (res?.status === "error") expect(res.message).not.toContain(CATEGORY_MSG);
    expect(txWrites(ops).some((o) => o.op === "insert")).toBe(true);
  });
});

describe("createExpense — Lesefehler bei der Kategorie-Prüfung (fail-closed)", () => {
  it("lehnt ab statt durchzulassen", async () => {
    const { client, ops } = makeFake({ categoryBelongs: true, categoryError: true });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createExpense({ status: "idle" }, expenseFormData({ category_id: CATEGORY_ID }));
    errSpy.mockRestore();
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain(CATEGORY_MSG);
    expect(txWrites(ops)).toHaveLength(0);
  });
});

describe("updateExpense — Kategorie muss zum Törn gehören", () => {
  const upd = (extra: Record<string, string> = {}) =>
    expenseFormData({ transaction_id: TX_ID, ...extra });

  it("weist eine Fremd-Kategorie ab, ohne zu schreiben", async () => {
    const { client, ops } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await updateExpense({ status: "idle" }, upd({ category_id: CATEGORY_ID }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain(CATEGORY_MSG);
    expect(txWrites(ops)).toHaveLength(0);
  });

  it("erlaubt eine eigene Kategorie", async () => {
    const { client, ops } = makeFake({ categoryBelongs: true });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await updateExpense({ status: "idle" }, upd({ category_id: CATEGORY_ID }));
    if (res?.status === "error") expect(res.message).not.toContain(CATEGORY_MSG);
    expect(txWrites(ops).some((o) => o.op === "update")).toBe(true);
  });

  it("erlaubt das Update ohne Kategorie", async () => {
    const { client, ops } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await updateExpense({ status: "idle" }, upd());
    if (res?.status === "error") expect(res.message).not.toContain(CATEGORY_MSG);
    expect(txWrites(ops).some((o) => o.op === "update")).toBe(true);
  });
});

describe("replayPendingTransaction — Kategorie muss zum Törn gehören", () => {
  const payload = (extra: Record<string, string> = {}) => ({
    trip_id: TRIP_ID,
    date: "2026-06-07",
    description: "Offline-Einkauf",
    paid_by: PERSON_ID,
    amount: "12,00",
    split_type: "equal",
    ...extra,
  });

  it("weist eine Fremd-Kategorie ab, ohne zu schreiben", async () => {
    const { client, ops } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await replayPendingTransaction("expense", payload({ category_id: CATEGORY_ID }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain(CATEGORY_MSG);
    expect(txWrites(ops)).toHaveLength(0);
  });

  it("erlaubt eine eigene Kategorie", async () => {
    const { client } = makeFake({ categoryBelongs: true });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await replayPendingTransaction("expense", payload({ category_id: CATEGORY_ID }));
    expect(res.ok).toBe(true);
  });

  it("erlaubt eine Buchung ohne Kategorie", async () => {
    const { client } = makeFake({ categoryBelongs: false });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await replayPendingTransaction("expense", payload());
    expect(res.ok).toBe(true);
  });
});
