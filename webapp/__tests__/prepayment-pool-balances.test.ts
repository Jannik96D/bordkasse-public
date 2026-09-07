// getPrepaymentPoolBalances (lib/queries/prepayments.ts) — PR 4 / Fix 5.
//
// Die Funktion soll dieselbe Grundgesamtheit zählen wie die SQL-View
// v_prepayment_payments (0025_self_payment_confirmation.sql): JEDE
// bestätigte Anzahlungs-Gutschrift von credit_from zählt als Pool-Beitrag
// dieser Person — unabhängig davon, an wen sie ging (credit_to).
//
// Die vorherige Implementierung verlangte zusätzlich `credit_to ===
// advancerId || Selbst-Credit`. Nach einem Crewwechsel (PR 4 / Fix 1, siehe
// replace-member.test.ts) bleibt eine übernommene Zahlung an credit_from = B
// hängen, ihr ursprüngliches credit_to zeigt aber weiterhin auf den
// DAMALIGEN Vorstrecker — bei einem künftigen Vorstrecker-Wechsel wäre eine
// solche Zahlung hier fälschlich verschluckt worden (isToAdvancer wird
// false), obwohl v_prepayment_payments sie weiterhin zählt.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/read-client", () => ({ readClient: vi.fn() }));

import { getPrepaymentPoolBalances } from "@/lib/queries/prepayments";
import { readClient } from "@/lib/supabase/read-client";

const mockedReadClient = vi.mocked(readClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ADVANCER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const CREW_A_ID = "aaaaaaaa-0000-4000-8000-000000000003";

function makeSupabase(txRows: Array<Record<string, unknown>>, oblRows: Array<Record<string, unknown>> = []) {
  const make = (table: string) => {
    let rows: Array<Record<string, unknown>> = table === "transactions" ? [...txRows] : table === "prepayment_obligations" ? [...oblRows] : [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return b;
    };
    b.not = () => b;
    b.is = (col: string, val: unknown) => {
      rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null });
    b.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    return b;
  };
  return { from: (table: string) => make(table) };
}

describe("getPrepaymentPoolBalances", () => {
  beforeEach(() => {
    mockedReadClient.mockReset();
  });

  it("zählt eine bestätigte Anzahlungs-Gutschrift, deren credit_to NICHT dem aktuellen Vorstrecker entspricht", async () => {
    // Repräsentiert exakt den Zustand nach einem Crewwechsel (Fix 1): die
    // Zahlung wurde per UPDATE auf credit_from = CREW_A_ID (die neue Person)
    // umgehängt, aber credit_to zeigt noch auf den historischen Empfänger,
    // NICHT auf den (hypothetisch inzwischen gewechselten) Vorstrecker.
    const historicalPayment = {
      trip_id: TRIP_ID,
      type: "credit",
      amount: 200,
      credit_from: CREW_A_ID,
      credit_to: "aaaaaaaa-0000-4000-8000-0000000000ff", // weder ADVANCER_ID noch self
      confirmed_at: "2026-08-01T10:00:00Z",
      tranche_id: "aaaaaaaa-0000-4000-8000-000000000009",
      deleted_at: null,
    };
    mockedReadClient.mockResolvedValue(makeSupabase([historicalPayment]) as never);

    const result = await getPrepaymentPoolBalances(TRIP_ID);
    const row = result.find((r) => r.person_id === CREW_A_ID);
    expect(row?.paid).toBe(200);
  });

  it("zählt weiterhin normale Zahlungen an den aktuellen Vorstrecker (kein Fehlalarm)", async () => {
    const normalPayment = {
      trip_id: TRIP_ID,
      type: "credit",
      amount: 100,
      credit_from: CREW_A_ID,
      credit_to: ADVANCER_ID,
      confirmed_at: "2026-08-01T10:00:00Z",
      tranche_id: "aaaaaaaa-0000-4000-8000-000000000009",
      deleted_at: null,
    };
    mockedReadClient.mockResolvedValue(makeSupabase([normalPayment]) as never);

    const result = await getPrepaymentPoolBalances(TRIP_ID);
    const row = result.find((r) => r.person_id === CREW_A_ID);
    expect(row?.paid).toBe(100);
  });

  it("zählt eine unbestätigte Selbstmeldung weiterhin NICHT (confirmed_at IS NULL)", async () => {
    const pending = {
      trip_id: TRIP_ID,
      type: "credit",
      amount: 999,
      credit_from: CREW_A_ID,
      credit_to: ADVANCER_ID,
      confirmed_at: null,
      tranche_id: "aaaaaaaa-0000-4000-8000-000000000009",
      deleted_at: null,
    };
    mockedReadClient.mockResolvedValue(makeSupabase([pending]) as never);

    const result = await getPrepaymentPoolBalances(TRIP_ID);
    const row = result.find((r) => r.person_id === CREW_A_ID);
    expect(row?.paid ?? 0).toBe(0);
  });
});
