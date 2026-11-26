// Sicherheitsrunde 2026-11, Slice 7 — Anzahlungs-Rechte:
//  (a) Ex-Vorstrecker (keine trip_members-Zeile) verliert die Vorstrecker-Rechte,
//  (b) rejectSelfPayment/confirmSelfPayment fassen nur echte Tranchen-Gutschriften an
//      (kein Ablehnen von Posten-Meldungen durch einen Vorstrecker).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/send", () => ({
  sendMail: vi.fn().mockResolvedValue({ ok: true }),
  sendMails: vi.fn().mockResolvedValue([]),
}));

import { requireSkipperAdminOrAdvancer } from "@/lib/auth/authz";
import { confirmSelfPayment, rejectSelfPayment } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAdmin = vi.mocked(createAdminClient);

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const ADVANCER = "aaaaaaaa-0000-4000-8000-000000000003";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000004";
const TRANCHE = "aaaaaaaa-0000-4000-8000-000000000010";
const ITEM = "aaaaaaaa-0000-4000-8000-000000000020";
const TX_TR = "aaaaaaaa-0000-4000-8000-0000000000f1";
const TX_ITEM = "aaaaaaaa-0000-4000-8000-0000000000f2";
const TX_EXP = "aaaaaaaa-0000-4000-8000-0000000000f3";

const pending = (id: string, extra: Row = {}): Row => ({
  id, trip_id: TRIP, type: "credit", tranche_id: TRANCHE, item_id: null, credit_from: ANNA, credit_to: ADVANCER,
  amount: 100, date: "2027-02-01", confirmed_at: null, deleted_at: null, ...extra,
});

let fake: ReturnType<typeof createFakeSupabase>;
function setup(opts: { advancerIsMember: boolean; transactions?: Row[] }) {
  const members: Row[] = [
    { trip_id: TRIP, person_id: OWNER, is_skipper: true },
    { trip_id: TRIP, person_id: ANNA, is_skipper: false },
  ];
  if (opts.advancerIsMember) members.push({ trip_id: TRIP, person_id: ADVANCER, is_skipper: false });
  fake = createFakeSupabase({
    trips: [{ id: TRIP, archived: false, skipper_id: OWNER, name: "Törn", trip_type: "sailing" }],
    trip_members: members,
    prepayment_plan: [{ trip_id: TRIP, advancer_person_id: ADVANCER, total_amount: 1000 }],
    prepayment_tranches: [{ id: TRANCHE, trip_id: TRIP, percent: 100, label: "Endzahlung", due_date: "2027-02-01" }],
    transactions: opts.transactions ?? [],
    audit_log: [],
  });
  fake.onRpc("mark_post_settlement_change", () => ({ data: null }));
  mockedAdmin.mockReturnValue(fake.client as never);
}
const tx = (id: string) => fake.rows("transactions").find((r) => r.id === id)!;
const form = (id: string) => {
  const f = new FormData();
  f.set("transaction_id", id);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_EMAILS;
});

describe("requireSkipperAdminOrAdvancer — Vorstrecker braucht Mitgliedschaft", () => {
  it("Vorstrecker MIT Mitgliedschaft darf", async () => {
    setup({ advancerIsMember: true });
    mockedPerson.mockResolvedValue({ id: ADVANCER, email: "a@example.test" } as never);
    expect((await requireSkipperAdminOrAdvancer(TRIP)).ok).toBe(true);
  });

  it("Ex-Vorstrecker OHNE trip_members-Zeile wird abgewiesen", async () => {
    setup({ advancerIsMember: false });
    mockedPerson.mockResolvedValue({ id: ADVANCER, email: "a@example.test" } as never);
    expect((await requireSkipperAdminOrAdvancer(TRIP)).ok).toBe(false);
  });

  it("Skipper-Zugriff bleibt unverändert", async () => {
    setup({ advancerIsMember: false });
    mockedPerson.mockResolvedValue({ id: OWNER, email: "o@example.test" } as never);
    expect((await requireSkipperAdminOrAdvancer(TRIP)).ok).toBe(true);
  });

  it("normales Mitglied wird abgewiesen", async () => {
    setup({ advancerIsMember: true });
    mockedPerson.mockResolvedValue({ id: ANNA, email: "n@example.test" } as never);
    expect((await requireSkipperAdminOrAdvancer(TRIP)).ok).toBe(false);
  });
});

describe("rejectSelfPayment / confirmSelfPayment — nur Tranchen-Gutschriften", () => {
  beforeEach(() => {
    mockedPerson.mockResolvedValue({ id: ADVANCER, email: "a@example.test" } as never);
  });

  const all = () => [
    pending(TX_TR),
    pending(TX_ITEM, { tranche_id: null, item_id: ITEM }),
    pending(TX_EXP, { type: "expense" }),
  ];

  it("echte Tranchen-Selbstmeldung lässt sich ablehnen", async () => {
    setup({ advancerIsMember: true, transactions: all() });
    expect((await rejectSelfPayment({ status: "idle" }, form(TX_TR))).status).toBe("ok");
    expect(tx(TX_TR).deleted_at).toBeTruthy();
  });

  it("echte Tranchen-Selbstmeldung lässt sich bestätigen", async () => {
    setup({ advancerIsMember: true, transactions: all() });
    expect((await confirmSelfPayment({ status: "idle" }, form(TX_TR))).status).toBe("ok");
    expect(tx(TX_TR).confirmed_at).toBeTruthy();
  });

  it("Posten-Selbstmeldung (keine Tranche) wird nicht abgelehnt", async () => {
    setup({ advancerIsMember: true, transactions: all() });
    const res = await rejectSelfPayment({ status: "idle" }, form(TX_ITEM));
    expect(res).toEqual({ status: "error", message: "Buchung nicht gefunden." });
    expect(tx(TX_ITEM).deleted_at).toBeNull();
  });

  it("rejectSelfPayment: Nicht-Gutschrift mit Tranche wird nicht abgelehnt", async () => {
    setup({ advancerIsMember: true, transactions: all() });
    expect(await rejectSelfPayment({ status: "idle" }, form(TX_EXP))).toEqual({
      status: "error",
      message: "Buchung nicht gefunden.",
    });
    expect(tx(TX_EXP).deleted_at).toBeNull();
  });

  it("confirmSelfPayment: Nicht-Gutschrift mit Tranche wird nicht bestätigt", async () => {
    setup({ advancerIsMember: true, transactions: all() });
    expect(await confirmSelfPayment({ status: "idle" }, form(TX_EXP))).toEqual({
      status: "error",
      message: "Buchung nicht gefunden.",
    });
    expect(tx(TX_EXP).confirmed_at).toBeNull();
  });

  it("Ex-Vorstrecker kann weder bestätigen noch ablehnen", async () => {
    setup({ advancerIsMember: false, transactions: all() });
    expect((await rejectSelfPayment({ status: "idle" }, form(TX_TR))).status).toBe("error");
    expect((await confirmSelfPayment({ status: "idle" }, form(TX_TR))).status).toBe("error");
    expect(tx(TX_TR).deleted_at).toBeNull();
    expect(tx(TX_TR).confirmed_at).toBeNull();
  });

  it("Skipper darf weiter ablehnen", async () => {
    mockedPerson.mockResolvedValue({ id: OWNER, email: "o@example.test" } as never);
    setup({ advancerIsMember: false, transactions: all() });
    expect((await rejectSelfPayment({ status: "idle" }, form(TX_TR))).status).toBe("ok");
  });
});
