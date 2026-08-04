// Regression zu Fund 7 (Code-Review 2026-08): savePrepaymentPlan schrieb
// advancer_person_id und obligations[].person_id bisher OHNE Prüfung, ob
// diese Personen wirklich Crew des Törns sind (anders als createExpense/
// createCredit/recordPayment, die personsBelongToTrip bereits nutzen). Bei
// "individuell"/"kojen" kommen die person_id-Werte roh aus dem Client-JSON;
// bei "gleichmaessig"/"zeitanteilig" werden sie serverseitig aus trip_members
// neu berechnet und sind daher inhärent sicher — genau DAS testet der
// zweite Fall hier, damit der neue Check den Recompute-Pfad nicht
// fälschlich blockiert.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { savePrepaymentPlan } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const CREW_1 = "aaaaaaaa-0000-4000-8000-000000000003";
const CREW_2 = "aaaaaaaa-0000-4000-8000-000000000004";
const FOREIGN_ID = "aaaaaaaa-0000-4000-8000-000000000009";

/**
 * Generischer Supabase-Mock: `trip_members` liefert für JEDE Query (sowohl
 * die gleichmaessig/zeitanteilig-Crew-Berechnung als auch den
 * personsBelongToTrip-Check) dieselbe `memberIds`-Liste — beide lesen nur
 * `person_id`, zusätzliche Spalten stören nicht.
 */
function makeSupabase(opts: { memberIds?: string[] } = {}) {
  const { memberIds = [] } = opts;
  const tripDates = { start_date: "2026-06-01", end_date: "2026-06-10" };
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.in = self;
    b.upsert = () => Promise.resolve({ error: null });
    b.insert = () => Promise.resolve({ error: null });
    b.delete = self;
    b.update = self;
    b.single = () => Promise.resolve(table === "trips" ? { data: tripDates } : { data: null });
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      let value: unknown = { data: [], error: null };
      if (table === "trip_members") {
        value = { data: memberIds.map((person_id) => ({ person_id, on_board_from: null, on_board_to: null })) };
      }
      if (table === "cabin_types") {
        value = { data: [] };
      }
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

function planFormData(payload: Record<string, unknown>): FormData {
  const fd = new FormData();
  fd.set("payload", JSON.stringify(payload));
  return fd;
}

describe("savePrepaymentPlan — Cross-Trip-Schutz für Obligations (Fund 7)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it('lehnt eine törnfremde person_id bei split_method="individuell" ab', async () => {
    // FOREIGN_ID kommt roh aus dem Client-Payload — memberIds ist leer,
    // die Person gehört also nicht zur Crew dieses Törns.
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 100,
        cabin_types: [],
        obligations: [{ person_id: FOREIGN_ID, total_amount: 100, cabin_type_id: null }],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("gehört nicht zu diesem Törn");
    }
  });

  it('lehnt eine törnfremde advancer_person_id ab (unabhängig von split_method)', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 300,
        advancer_person_id: FOREIGN_ID,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("gehört nicht zu diesem Törn");
    }
  });

  it('blockiert den serverseitig berechneten Pfad bei split_method="gleichmaessig" NICHT (Recompute ist bereits trip-scoped)', async () => {
    // computedObligations wird für gleichmaessig komplett aus trip_members
    // neu berechnet (das Client-Payload für `obligations` wird verworfen) —
    // der neue Check darf diesen legitimen Pfad nicht fälschlich blocken.
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 300,
        cabin_types: [],
        obligations: [], // Client sendet für gleichmaessig ohnehin keine eigenen Obligations
      }),
    );

    expect(res.status).toBe("ok");
  });

  it('blockiert den serverseitig berechneten Pfad bei split_method="zeitanteilig" ebenfalls NICHT', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "zeitanteilig",
        total_amount: 300,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("ok");
  });
});
