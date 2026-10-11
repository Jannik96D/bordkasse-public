// Bugfix Doppelzahlung (Anzahlungsplan): „Einzahlung erfassen" bei offener
// Selbstmeldung ließ die Meldung stehen — ein späteres „Bestätigen" buchte
// dasselbe Geld doppelt, und die Überzahlung ließ sich auf der Anzahlungs-
// Seite nicht entfernen. Läuft gegen den filternden In-Memory-Fake: geprüft
// wird, was am Ende WIRKLICH in `transactions` steht.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireMember: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/send", () => ({
  sendMail: vi.fn().mockResolvedValue({ ok: true }),
  sendMails: vi.fn().mockResolvedValue([]),
}));

import { recordPayment, confirmSelfPayment, deletePrepaymentPayment } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperAdminOrAdvancer } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";
import { overflowKeyFor } from "@/lib/prepayments/resolve-pending";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("overflowKeyFor", () => {
  it("liefert eine gültige UUID (idempotency_key ist uuid-typisiert), deterministisch und verschieden vom Basis-Key", () => {
    const k = overflowKeyFor(KEY);
    expect(k).toMatch(UUID_RE);
    expect(k).toBe(overflowKeyFor(KEY));
    expect(k).not.toBe(KEY);
    expect(overflowKeyFor("aaaaaaaa-0000-4000-8000-0000000000e2")).not.toBe(k);
  });
});

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAdvancer = vi.mocked(requireSkipperAdminOrAdvancer);
const mockedAdmin = vi.mocked(createAdminClient);

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TRIP = "aaaaaaaa-0000-4000-8000-000000000099";
const SKIPPER = "aaaaaaaa-0000-4000-8000-000000000002";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000003";
const BEN = "aaaaaaaa-0000-4000-8000-000000000004";
const TRANCHE = "aaaaaaaa-0000-4000-8000-000000000010";
const TRANCHE_2 = "aaaaaaaa-0000-4000-8000-000000000011";
const PEND = "aaaaaaaa-0000-4000-8000-0000000000f1";
const PEND_LATE = "aaaaaaaa-0000-4000-8000-0000000000f2";
const PAY = "aaaaaaaa-0000-4000-8000-0000000000f3";
const KEY = "aaaaaaaa-0000-4000-8000-0000000000e1";

const credit = (id: string, extra: Row = {}): Row => ({
  id, trip_id: TRIP, type: "credit", tranche_id: TRANCHE, item_id: null, credit_from: ANNA, credit_to: SKIPPER,
  amount: 200, date: "2027-01-30", confirmed_at: null, deleted_at: null, idempotency_key: null, ...extra,
});

function tables(transactions: Row[], extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    trips: [{ id: TRIP, archived: false, skipper_id: SKIPPER, name: "Törn", trip_type: "sailing" }],
    trip_members: [
      { trip_id: TRIP, person_id: SKIPPER },
      { trip_id: TRIP, person_id: ANNA },
      { trip_id: TRIP, person_id: BEN },
    ],
    prepayment_plan: [{ trip_id: TRIP, advancer_person_id: SKIPPER, total_amount: 1200 }],
    prepayment_obligations: [{ trip_id: TRIP, person_id: ANNA, total_amount: 400 }],
    prepayment_tranches: [
      { id: TRANCHE, trip_id: TRIP, percent: 50, label: "1. Anzahlung", due_date: "2027-02-01" },
      { id: TRANCHE_2, trip_id: TRIP, percent: 50, label: "Endzahlung", due_date: "2027-04-01" },
    ],
    transactions,
    audit_log: [],
    ...extra,
  };
}

let fake: ReturnType<typeof createFakeSupabase>;
function setup(t: Record<string, Row[]>) {
  fake = createFakeSupabase(t);
  fake.onRpc("mark_post_settlement_change", () => ({ data: null }));
  mockedAdmin.mockReturnValue(fake.client as never);
}
const tx = (id: string) => fake.rows("transactions").find((r) => r.id === id)!;
const live = () => fake.rows("transactions").filter((r) => !r.deleted_at);
/** Σ bestätigte, lebende Einzahlungen von Anna auf die Tranche (wie v_prepayment_payments). */
const annaPaid = () =>
  live()
    .filter((r) => r.credit_from === ANNA && r.confirmed_at)
    .reduce((s, r) => s + Number(r.amount), 0);

function record(resolveIds: string[], amount = "200", extra: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ trip_id: TRIP, tranche_id: TRANCHE, person_id: ANNA, amount, date: "2027-02-01", idempotency_key: KEY, ...extra })) {
    f.set(k, v);
  }
  for (const id of resolveIds) f.append("resolve_pending_ids", id);
  return recordPayment({ status: "idle" }, f);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPerson.mockResolvedValue({ id: SKIPPER, display_name: "Skipper" } as never);
  mockedAdvancer.mockResolvedValue({ ok: true, personId: SKIPPER } as never);
});

describe("recordPayment — offene Selbstmeldung erledigen", () => {
  it("mit Haken: Meldung verschwindet; ein veralteter Banner-Klick bucht nichts doppelt", async () => {
    setup(tables([credit(PEND)]));
    expect((await record([PEND])).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeTruthy();
    const f = new FormData();
    f.set("transaction_id", PEND);
    expect((await confirmSelfPayment({ status: "idle" }, f)).status).toBe("error");
    expect(annaPaid()).toBe(200);
  });

  it("ohne Haken bleibt die Meldung offen (wie bisher)", async () => {
    setup(tables([credit(PEND)]));
    expect((await record([])).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeFalsy();
  });

  it("nur angezeigte IDs, nur offene Meldungen derselben Person + Tranche", async () => {
    setup(tables([
      credit(PEND),
      credit(PEND_LATE),
      credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z" }),
    ]));
    const BEN_PEND = "aaaaaaaa-0000-4000-8000-0000000000f4";
    fake.rows("transactions").push(credit(BEN_PEND, { credit_from: BEN }));
    expect((await record([PEND, PAY, BEN_PEND])).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeTruthy();
    expect(tx(PEND_LATE).deleted_at).toBeFalsy(); // nicht angezeigt
    expect(tx(PAY).deleted_at).toBeFalsy(); // bestätigt → nie über diesen Weg
    expect(tx(BEN_PEND).deleted_at).toBeFalsy(); // andere Person
  });

  it("Erledigen scheitert → Fehler; Retry mit gleichem Key holt es nach, ohne Doppelbuchung", async () => {
    setup(tables([credit(PEND)]));
    fake.failOn({ table: "transactions", action: "update" });
    expect((await record([PEND])).status).toBe("error");
    expect(tx(PEND).deleted_at).toBeFalsy();
    expect((await record([PEND])).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeTruthy();
    expect(annaPaid()).toBe(200);
  });

  it("Grill-Fund: Retry MIT Überschuss-Umbuchung bucht den Überschuss nicht ein zweites Mal", async () => {
    // Rate-Soll 200 (400 × 50 %). Erfasst 300 → 200 auf Rate 1 + 100 auf Rate 2.
    setup(tables([credit(PEND, { amount: 300 })]));
    fake.failOn({ table: "transactions", action: "update" });
    expect((await record([PEND], "300", { overflow_tranche_id: TRANCHE_2 })).status).toBe("error");
    expect(annaPaid()).toBe(300);
    // Zweiter Versuch: open ist jetzt 0 → ohne Schutz würde der GANZE Betrag als Überschuss neu gebucht.
    expect((await record([PEND], "300", { overflow_tranche_id: TRANCHE_2 })).status).toBe("ok");
    expect(annaPaid()).toBe(300);
    expect(tx(PEND).deleted_at).toBeTruthy();
    expect(fake.rows("audit_log").filter((a) => (a.payload as Row)?.kind === "prepayment")).toHaveLength(1);
  });

  it("Meldung auf Rate 1, Erfassung auf Rate 2 → Meldung wird trotzdem erledigt", async () => {
    setup(tables([credit(PEND)]));
    expect((await record([PEND], "200", { tranche_id: TRANCHE_2 })).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeTruthy();
  });

  it("Meldung einer weiteren Zahlung (item_id) ist kein Plan-Pool → bleibt", async () => {
    setup(tables([credit(PEND, { tranche_id: null, item_id: "aaaaaaaa-0000-4000-8000-0000000000d1" })]));
    expect((await record([PEND])).status).toBe("ok");
    expect(tx(PEND).deleted_at).toBeFalsy();
  });

  it("weist eine ungültige ID ab, bevor gebucht wird", async () => {
    setup(tables([credit(PEND)]));
    expect((await record(["kein-uuid"])).status).toBe("error");
    expect(live().filter((r) => r.confirmed_at)).toHaveLength(0);
  });
});

describe("deletePrepaymentPayment — Doppel-/Überzahlung zurücknehmen", () => {
  const del = (id = PAY, trip = TRIP) => {
    const f = new FormData();
    f.set("trip_id", trip);
    f.set("transaction_id", id);
    return deletePrepaymentPayment({ status: "idle" }, f);
  };

  it("soft-löscht die bestätigte Einzahlung + räumt den Erinnerungs-Log + markiert die Abrechnung", async () => {
    setup(tables([credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z" })], {
      prepayment_reminder_log: [{ tranche_id: TRANCHE, person_id: ANNA, reminder_type: "crew_3d" }],
    }));
    expect((await del()).status).toBe("ok");
    expect(tx(PAY).deleted_at).toBeTruthy();
    expect(fake.rows("prepayment_reminder_log")).toHaveLength(0);
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(true);
  });

  it("ohne Rolle (Crew) → nichts passiert", async () => {
    setup(tables([credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z" })]));
    mockedAdvancer.mockResolvedValue({ ok: false, message: "Keine Berechtigung." } as never);
    expect((await del()).status).toBe("error");
    expect(tx(PAY).deleted_at).toBeFalsy();
  });

  it("offene Meldung, Bordkasse-Gutschrift und Charter-Ausgabe sind ausgenommen", async () => {
    for (const row of [
      credit(PAY), // pending → „Ablehnen"
      credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z", tranche_id: null }), // Bordkasse
      credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z", type: "expense" }), // an den Anbieter
    ]) {
      setup(tables([row]));
      expect((await del()).status).toBe("error");
      expect(tx(PAY).deleted_at).toBeFalsy();
    }
  });

  it("IDOR: Buchung eines anderen Törns bleibt unangetastet", async () => {
    setup(tables([credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z", trip_id: OTHER_TRIP })]));
    expect((await del()).status).toBe("error");
    expect(tx(PAY).deleted_at).toBeFalsy();
  });

  it("archivierter Törn → kein Entfernen", async () => {
    const t = tables([credit(PAY, { confirmed_at: "2027-01-01T00:00:00Z" })]);
    t.trips[0].archived = true;
    setup(t);
    expect((await del()).status).toBe("error");
    expect(tx(PAY).deleted_at).toBeFalsy();
  });
});
