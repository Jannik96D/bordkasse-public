// Reise-Posten im generischen Buchungs-Edit (lib/actions/transactions.ts, PR4a).
//
// item_id ist im Edit unveränderlich; die DB-Regeln des Postens
// (tx_pool_exclusive, tx_item_credit_direct, tx_item_credit_payee) werden
// vorab mit verständlicher Meldung geprüft, und eine Anbieter-Zahlung lässt
// sich nur noch bilanzneutral (Beschreibung/Kategorie/Datum) ändern.
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

import { updateCredit, updateExpense } from "@/lib/actions/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin, requireSkipperAdminOrAdvancer, isAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const TRIP = "cccccccc-0000-4000-8000-000000000001";
const PAYEE = "cccccccc-0000-4000-8000-000000000002";
const ANNA = "cccccccc-0000-4000-8000-000000000003";
const BEN = "cccccccc-0000-4000-8000-000000000004";
const ITEM = "cccccccc-0000-4000-8000-0000000000d1";
const TRANCHE = "cccccccc-0000-4000-8000-0000000000e1";
const CREDIT_TX = "cccccccc-0000-4000-8000-0000000000f1";
const EXPENSE_TX = "cccccccc-0000-4000-8000-0000000000f2";

let fake: ReturnType<typeof createFakeSupabase>;

function tables(): Record<string, Row[]> {
  return {
    trips: [{ id: TRIP, archived: false, skipper_id: PAYEE, start_date: "2027-05-01", end_date: "2027-05-10", trip_type: "sailing" }],
    trip_members: [
      { trip_id: TRIP, person_id: PAYEE, on_board_from: null, on_board_to: null },
      { trip_id: TRIP, person_id: ANNA, on_board_from: null, on_board_to: null },
      { trip_id: TRIP, person_id: BEN, on_board_from: null, on_board_to: null },
    ],
    prepayment_items: [{ id: ITEM, trip_id: TRIP, payee_person_id: PAYEE, label: "Flüge", total_amount: 200 }],
    prepayment_tranches: [{ id: TRANCHE, trip_id: TRIP }],
    trip_categories: [],
    transactions: [
      {
        id: CREDIT_TX, trip_id: TRIP, type: "credit", created_by: PAYEE, deleted_at: null, amount: 100,
        credit_from: ANNA, credit_to: PAYEE, tranche_id: null, item_id: ITEM, confirmed_at: "x",
      },
      {
        id: EXPENSE_TX, trip_id: TRIP, type: "expense", created_by: PAYEE, deleted_at: null, description: "Flüge",
        category_id: null, date: "2027-02-01", paid_by: PAYEE, amount: 200, alcohol_amount: 0, tip_amount: 0,
        tip_distribution: "proportional", split_type: "per_person", tranche_id: null, item_id: ITEM,
        original_currency: null, original_amount: null, exchange_rate: null, rate_source: null, rate_confirmed_at: null,
      },
    ],
    transaction_participants: [
      { transaction_id: EXPENSE_TX, person_id: ANNA, amount: 100, original_amount: null },
      { transaction_id: EXPENSE_TX, person_id: BEN, amount: 100, original_amount: null },
    ],
    audit_log: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = createFakeSupabase(tables());
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
  vi.mocked(getCurrentPerson).mockResolvedValue({ id: PAYEE, display_name: "P" } as never);
  vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: PAYEE });
  vi.mocked(requireSkipperAdminOrAdvancer).mockResolvedValue({ ok: true, personId: PAYEE });
  vi.mocked(isAdmin).mockResolvedValue(false);
});

function creditFd(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("transaction_id", CREDIT_TX);
  f.set("trip_id", TRIP);
  f.set("date", "2027-02-02");
  f.set("description", "Flug");
  f.set("amount", "100,00");
  f.set("credit_from", ANNA);
  f.set("credit_to", PAYEE);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

function expenseFd(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("transaction_id", EXPENSE_TX);
  f.set("trip_id", TRIP);
  f.set("date", "2027-02-01");
  f.set("description", "Flüge");
  f.set("paid_by", PAYEE);
  f.set("amount", "200,00");
  f.set("split_type", "per_person");
  f.set("participant_amounts", JSON.stringify([{ person_id: ANNA, amount: 100 }, { person_id: BEN, amount: 100 }]));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

const credit = () => fake.rows("transactions").find((t) => t.id === CREDIT_TX)!;
const expense = () => fake.rows("transactions").find((t) => t.id === EXPENSE_TX)!;

describe("updateCredit — Posten-Gutschrift", () => {
  it("„An Alle“ wird vorab mit verständlicher Meldung abgewiesen (tx_item_credit_direct)", async () => {
    const res = await updateCredit({ status: "idle" }, creditFd({ credit_to: "ALL" }));
    expect(res).toMatchObject({ status: "error", field: "credit_to" });
    if (res.status === "error") expect(res.message).toContain("An Alle");
    expect(credit().credit_to).toBe(PAYEE);
  });

  it("ein anderer Empfänger als der Posten-Empfänger wird abgewiesen", async () => {
    const res = await updateCredit({ status: "idle" }, creditFd({ credit_to: BEN }));
    expect(res).toMatchObject({ status: "error", field: "credit_to" });
    expect(credit().credit_to).toBe(PAYEE);
  });

  it("zusätzlich eine Tranche → tx_pool_exclusive-Meldung", async () => {
    const res = await updateCredit({ status: "idle" }, creditFd({ tranche_id: TRANCHE, tranche_field_present: "1" }));
    expect(res).toMatchObject({ status: "error", field: "tranche_id" });
    expect(credit().tranche_id).toBeNull();
  });

  it("Betragsänderung bleibt erlaubt, item_id bleibt, Bestätigung wird zurückgesetzt", async () => {
    await updateCredit({ status: "idle" }, creditFd({ amount: "80,00", item_id: "" }));
    expect(redirect).toHaveBeenCalled();
    expect(credit()).toMatchObject({ amount: 80, item_id: ITEM, confirmed_at: null });
  });

  it("DB-Race: Trigger-Fehler wird übersetzt", async () => {
    fake.failOn({ table: "transactions", action: "update", error: { code: "P0001", message: "prepayment_item_credit_wrong_payee" } });
    const res = await updateCredit({ status: "idle" }, creditFd({ amount: "90,00" }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("empfängt");
  });
});

describe("updateExpense — Anbieter-Zahlung eines Postens", () => {
  it("Betragsänderung ist gesperrt", async () => {
    const res = await updateExpense({ status: "idle" }, expenseFd({
      amount: "180,00",
      participant_amounts: JSON.stringify([{ person_id: ANNA, amount: 90 }, { person_id: BEN, amount: 90 }]),
    }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Anbieter");
    expect(expense().amount).toBe(200);
  });

  it("Wechsel auf „Gleichmäßig“ ist gesperrt", async () => {
    const res = await updateExpense({ status: "idle" }, expenseFd({ split_type: "equal", participant_amounts: "" }));
    expect(res.status).toBe("error");
    expect(expense().split_type).toBe("per_person");
  });

  it("anderer Zahler ist gesperrt", async () => {
    const res = await updateExpense({ status: "idle" }, expenseFd({ paid_by: ANNA }));
    expect(res.status).toBe("error");
    expect(expense().paid_by).toBe(PAYEE);
  });

  it("Beschreibung + Datum bleiben änderbar, item_id bleibt erhalten", async () => {
    const res = await updateExpense({ status: "idle" }, expenseFd({ description: "Flüge Hamburg", date: "2027-02-03", item_id: "" }));
    expect(res).toBeUndefined(); // redirect (gemockt) statt Rückgabe
    expect(expense()).toMatchObject({ description: "Flüge Hamburg", date: "2027-02-03", item_id: ITEM, amount: 200 });
  });

  it("zusätzlich eine Tranche → tx_pool_exclusive-Meldung", async () => {
    const res = await updateExpense({ status: "idle" }, expenseFd({ tranche_id: TRANCHE, tranche_field_present: "1" }));
    expect(res).toMatchObject({ status: "error", field: "tranche_id" });
    expect(expense().tranche_id).toBeNull();
  });
});
