// Reise-Posten × Crew-Verwaltung und Auth-Helfer (PR4a).
//
//   • requireSkipperAdminOrItemPayee / itemBelongsToTrip / personHasBookingTrace
//   • removeMember: Empfänger + offenes Posten-Soll blocken
//   • replaceMember: Empfänger-Guard, Posten-Selbstmeldung blockt, Soll +
//     Anbieter-Anteile + Posten-Gutschriften wandern (Modus 1 und 2)
//   • Ghost-Merge: Empfängerwechsel per move_item_payee VOR jedem anderen
//     Schreibschritt, Posten-Soll wird übernommen statt per CASCADE zu
//     verschwinden
// Läuft gegen den filternden In-Memory-Fake (helpers/fake-supabase).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/auth/origin", () => ({ resolveOrigin: vi.fn(() => "https://example.test"), appOrigin: vi.fn(() => "https://example.test") }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const mockedAdmin = vi.mocked(createAdminClient);
const mockedPerson = vi.mocked(getCurrentPerson);

const TRIP = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_TRIP = "bbbbbbbb-0000-4000-8000-000000000099";
const SKIPPER = "bbbbbbbb-0000-4000-8000-000000000002";
const PAYEE = "bbbbbbbb-0000-4000-8000-000000000003";
const A = "bbbbbbbb-0000-4000-8000-000000000004"; // wird ersetzt / entfernt
const B_NEW = "bbbbbbbb-0000-4000-8000-000000000005"; // neue Person im Wechsel
const OTHER = "bbbbbbbb-0000-4000-8000-000000000006";
const ITEM = "bbbbbbbb-0000-4000-8000-0000000000d1";
const A_MEMBER_ROW = "bbbbbbbb-0000-4000-8000-0000000000a4";
const PROVIDER_TX = "bbbbbbbb-0000-4000-8000-0000000000f1";

let fake: ReturnType<typeof createFakeSupabase>;
function setupFake(tables: Record<string, Row[]>) {
  fake = createFakeSupabase(tables);
  fake.onRpc("mark_post_settlement_change", () => ({ data: null }));
  mockedAdmin.mockReturnValue(fake.client as never);
  return fake;
}

function tables(opts: { start?: string; end?: string; payee?: string } = {}): Record<string, Row[]> {
  return {
    trips: [
      { id: TRIP, archived: false, skipper_id: SKIPPER, start_date: opts.start ?? "2099-05-01", end_date: opts.end ?? "2099-05-10" },
      { id: OTHER_TRIP, archived: false, skipper_id: OTHER, start_date: "2099-06-01", end_date: "2099-06-10" },
    ],
    persons: [
      { id: SKIPPER, auth_user_id: "u1", display_name: "Skipper" },
      { id: PAYEE, auth_user_id: null, display_name: "Payee" },
      { id: A, auth_user_id: null, display_name: "A" },
      { id: OTHER, auth_user_id: null, display_name: "Other" },
    ],
    persons_private: [],
    trip_members: [
      { id: "m-s", trip_id: TRIP, person_id: SKIPPER, is_skipper: true, on_board_from: null, on_board_to: null },
      { id: "bbbbbbbb-0000-4000-8000-0000000000a3", trip_id: TRIP, person_id: PAYEE, is_skipper: false, on_board_from: null, on_board_to: null },
      { id: A_MEMBER_ROW, trip_id: TRIP, person_id: A, is_skipper: false, on_board_from: null, on_board_to: null, is_alcoholic: null, note: null },
      { id: "m-o", trip_id: OTHER_TRIP, person_id: OTHER, is_skipper: true, on_board_from: null, on_board_to: null },
    ],
    prepayment_items: [
      { id: ITEM, trip_id: TRIP, label: "Flüge", total_amount: 300, payee_person_id: opts.payee ?? PAYEE, split_type: "gleichmaessig", sort_order: 0 },
    ],
    prepayment_item_obligations: [
      { item_id: ITEM, trip_id: TRIP, person_id: SKIPPER, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: PAYEE, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: A, amount: 100 },
    ],
    // Anbieter-Zahlung des Empfängers (per_person = Soll).
    transactions: [
      { id: PROVIDER_TX, trip_id: TRIP, type: "expense", item_id: ITEM, tranche_id: null, paid_by: PAYEE, amount: 300, date: "2099-01-10", deleted_at: null, confirmed_at: "x" },
    ],
    transaction_participants: [
      { transaction_id: PROVIDER_TX, person_id: SKIPPER, amount: 100 },
      { transaction_id: PROVIDER_TX, person_id: PAYEE, amount: 100 },
      { transaction_id: PROVIDER_TX, person_id: A, amount: 100 },
    ],
    prepayment_obligations: [],
    prepayment_plan: [],
    prepayment_tranches: [],
    settled_debts: [],
    audit_log: [],
    trip_statistics_audience: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "";
  mockedPerson.mockResolvedValue({ id: SKIPPER, display_name: "Skipper", email: "s@example.test" } as never);
});

// ─────────────────────────────────────────────────────────────────────────
describe("requireSkipperAdminOrItemPayee", () => {
  it("Empfänger (noch Crew) darf — liefert tripId + Empfänger des Postens", async () => {
    const { requireSkipperAdminOrItemPayee } = await import("@/lib/auth/authz");
    setupFake(tables());
    mockedPerson.mockResolvedValue({ id: PAYEE, display_name: "Payee" } as never);
    expect(await requireSkipperAdminOrItemPayee(ITEM)).toEqual({ ok: true, personId: PAYEE, tripId: TRIP, payeePersonId: PAYEE });
  });

  it("Empfänger, der nicht mehr Crew ist, darf nicht mehr", async () => {
    const { requireSkipperAdminOrItemPayee } = await import("@/lib/auth/authz");
    const t = tables();
    t.trip_members = t.trip_members.filter((m) => m.person_id !== PAYEE);
    setupFake(t);
    mockedPerson.mockResolvedValue({ id: PAYEE, display_name: "Payee" } as never);
    expect((await requireSkipperAdminOrItemPayee(ITEM)).ok).toBe(false);
  });

  it("Skipper des Törns darf, gewöhnliches Crewmitglied nicht", async () => {
    const { requireSkipperAdminOrItemPayee } = await import("@/lib/auth/authz");
    setupFake(tables());
    expect((await requireSkipperAdminOrItemPayee(ITEM)).ok).toBe(true);
    mockedPerson.mockResolvedValue({ id: A, display_name: "A" } as never);
    expect((await requireSkipperAdminOrItemPayee(ITEM)).ok).toBe(false);
  });

  it("Skipper eines ANDEREN Törns darf nicht", async () => {
    const { requireSkipperAdminOrItemPayee } = await import("@/lib/auth/authz");
    setupFake(tables());
    mockedPerson.mockResolvedValue({ id: OTHER, display_name: "Other" } as never);
    expect((await requireSkipperAdminOrItemPayee(ITEM)).ok).toBe(false);
  });

  it("Lesefehler → abgelehnt (fail-closed)", async () => {
    const { requireSkipperAdminOrItemPayee } = await import("@/lib/auth/authz");
    setupFake(tables());
    fake.failOn({ table: "prepayment_items", action: "select" });
    expect((await requireSkipperAdminOrItemPayee(ITEM)).ok).toBe(false);
  });
});

describe("cross-trip: itemBelongsToTrip / personHasBookingTrace", () => {
  it("itemBelongsToTrip: fremder Törn → false, Lesefehler → false, null → true", async () => {
    const { itemBelongsToTrip } = await import("@/lib/auth/cross-trip");
    setupFake(tables());
    expect(await itemBelongsToTrip(fake.client as never, ITEM, TRIP)).toBe(true);
    expect(await itemBelongsToTrip(fake.client as never, ITEM, OTHER_TRIP)).toBe(false);
    expect(await itemBelongsToTrip(fake.client as never, null, TRIP)).toBe(true);
    fake.failOn({ table: "prepayment_items", action: "select" });
    expect(await itemBelongsToTrip(fake.client as never, ITEM, TRIP)).toBe(false);
  });

  it("personHasBookingTrace: Empfänger ohne jede Buchung ist eine Spur", async () => {
    const { personHasBookingTrace } = await import("@/lib/auth/cross-trip");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    expect(await personHasBookingTrace(fake.client as never, TRIP, PAYEE)).toBe(true);
    expect(await personHasBookingTrace(fake.client as never, TRIP, A)).toBe(false);
  });

  it("personHasBookingTrace: excludeItemParticipants ignoriert nur Anteile an Posten-Ausgaben", async () => {
    const { personHasBookingTrace } = await import("@/lib/auth/cross-trip");
    setupFake(tables());
    expect(await personHasBookingTrace(fake.client as never, TRIP, A)).toBe(true);
    expect(await personHasBookingTrace(fake.client as never, TRIP, A, { excludeItemParticipants: true })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("removeMember mit Posten", () => {
  it("blockt den Empfänger eines Postens", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_item_obligations = [];
    setupFake(t);
    const res = await removeMember("bbbbbbbb-0000-4000-8000-0000000000a3", TRIP);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("weitere Zahlung");
    expect(fake.rows("trip_members").some((m) => m.person_id === PAYEE)).toBe(true);
  });

  it("M3: offenes Soll (gleichmäßig, keine Zahlung) wird auf die verbleibende Crew neu verteilt", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(true);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(false);
    const obl = fake.rows("prepayment_item_obligations").filter((o) => o.item_id === ITEM);
    expect(obl.some((o) => o.person_id === A)).toBe(false);
    expect(obl.map((o) => o.amount).sort()).toEqual([150, 150]);
  });

  it("PR5: Umverteilung setzt den Erinnerungs-Log des Postens zurück und löscht die Zeilen von A", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const OTHER_ITEM = "bbbbbbbb-0000-4000-8000-0000000000d2";
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_item_reminder_log = [
      { trip_id: TRIP, item_id: ITEM, person_id: PAYEE, reminder_type: "item_payee_3d" },
      { trip_id: TRIP, item_id: ITEM, person_id: SKIPPER, reminder_type: "item_crew_3d" },
      // Posten ohne Umverteilung: nur die Zeile von A geht, die anderen bleiben.
      { trip_id: TRIP, item_id: OTHER_ITEM, person_id: A, reminder_type: "item_crew_3d" },
      { trip_id: TRIP, item_id: OTHER_ITEM, person_id: SKIPPER, reminder_type: "item_crew_3d" },
      // Fremder Törn bleibt.
      { trip_id: OTHER_TRIP, item_id: "x", person_id: A, reminder_type: "item_crew_3d" },
    ];
    setupFake(t);
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(true);
    const left = fake.rows("prepayment_item_reminder_log").map((r) => `${r.trip_id === TRIP ? "T" : "O"}:${r.item_id}:${r.person_id}`).sort();
    expect(left).toEqual([`O:x:${A}`, `T:${OTHER_ITEM}:${SKIPPER}`].sort());
  });

  it("PR5: scheitert das Log-Aufräumen, wird trotzdem entfernt", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    fake.failOn({ table: "prepayment_item_reminder_log", action: "delete", error: { code: "42P01", message: "missing" } });
    fake.failOn({ table: "prepayment_item_reminder_log", action: "delete", nth: 2, error: { code: "42P01", message: "missing" } });
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(true);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(false);
  });

  it("Delta 2: ein Nachrücker ohne Soll für den Posten bekommt bei der Neuverteilung keins", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.persons.push({ id: B_NEW, auth_user_id: null, display_name: "E" });
    t.trip_members.push({ id: "bbbbbbbb-0000-4000-8000-0000000000a5", trip_id: TRIP, person_id: B_NEW, is_skipper: false, on_board_from: null, on_board_to: null });
    setupFake(t);
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(true);
    const obl = fake.rows("prepayment_item_obligations").filter((o) => o.item_id === ITEM);
    expect(obl.some((o) => o.person_id === B_NEW)).toBe(false);
    expect(obl.map((o) => o.amount).sort()).toEqual([150, 150]);
  });

  it("Delta 2: zeitanteilig verteilt nach den Tagen der verbleibenden Soll-Inhaber", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_items[0].split_type = "zeitanteilig";
    // Skipper 10 Tage, Payee 5 Tage (Törn 01.–10.05.)
    t.trip_members = t.trip_members.map((m) => (m.person_id === PAYEE ? { ...m, on_board_to: "2099-05-05" } : m));
    setupFake(t);
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(true);
    const by = Object.fromEntries(fake.rows("prepayment_item_obligations").map((o) => [o.person_id, o.amount]));
    expect(by[SKIPPER]).toBe(200);
    expect(by[PAYEE]).toBe(100);
  });

  it("Delta 1: erst Upsert der Rest-Crew, dann Löschen von A — nie ein Posten ohne Sollzeilen", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    let minRows = Infinity;
    for (let n = 1; n <= 12; n++) {
      fake.onFrom("prepayment_item_obligations", n, () => {
        minRows = Math.min(minRows, fake.rows("prepayment_item_obligations").filter((o) => o.item_id === ITEM).length);
      });
    }
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(true);
    expect(minRows).toBeGreaterThan(0);
    expect(fake.writes.find((w) => w.table === "prepayment_item_obligations")?.action).toBe("upsert");
  });

  it("Delta 1: scheitert das Löschen der Zeile von A, kommen die alten Beträge zurück", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    fake.failOn({ table: "prepayment_item_obligations", action: "delete" });
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(false);
    const by = Object.fromEntries(fake.rows("prepayment_item_obligations").map((o) => [o.person_id, o.amount]));
    expect(by).toEqual({ [SKIPPER]: 100, [PAYEE]: 100, [A]: 100 });
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(true);
  });

  it("Delta 5: entsteht während der Neuverteilung eine Anbieter-Zahlung, wird zurückgerollt", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    // transactions-Aufrufe: Spur-Check (1), Planung (2), Nachkontrolle (3).
    fake.onFrom("transactions", 3, () =>
      fake.rows("transactions").push({ id: "late", trip_id: TRIP, type: "expense", item_id: ITEM, paid_by: PAYEE, amount: 300, deleted_at: null }),
    );
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(false);
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(true);
  });

  it("Delta 5: scheitert das Entfernen der Mitgliedschaft, kommt das alte Soll zurück; sonst Audit ohne PII", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    fake.failOn({ table: "trip_members", action: "delete" });
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(false);
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);

    const t2 = tables();
    t2.transactions = [];
    t2.transaction_participants = [];
    setupFake(t2);
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(true);
    const audit = fake.rows("audit_log").find((a) => (a.payload as Row)?.kind === "item-soll-redistributed");
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit!.payload)).not.toMatch(/Flüge|Payee|Skipper/);
  });

  it("M3: nach dem Entfernen bleibt das neu verteilte Soll beim Umbenennen des Postens stehen", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const { saveItem } = await import("@/lib/actions/prepayment-items");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    setupFake(t);
    expect((await removeMember(A_MEMBER_ROW, TRIP)).ok).toBe(true);
    const f = new FormData();
    f.set("payload", JSON.stringify({ trip_id: TRIP, id: ITEM, label: "Flüge neu", total_amount: "300", split_type: "gleichmaessig", payee_person_id: PAYEE }));
    expect((await saveItem({ status: "idle" }, f)).status).toBe("ok");
    const obl = fake.rows("prepayment_item_obligations").filter((o) => o.item_id === ITEM);
    expect(obl.map((o) => o.amount).sort()).toEqual([150, 150]);
  });

  it("M3: offenes Soll mit Anbieter-Zahlung → blockt mit Hinweis", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transaction_participants = t.transaction_participants.filter((p) => p.person_id !== A);
    setupFake(t);
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Anbieter");
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(true);
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
  });

  it("M3: offenes Soll bei „individuell“ → blockt", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_items[0].split_type = "individuell";
    setupFake(t);
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("auf andere verteilen");
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
  });

  it("M3: Aufräumen schlägt fehl → Person bleibt Crew (fail-loud)", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_item_obligations = t.prepayment_item_obligations.map((o) => (o.person_id === A ? { ...o, amount: 0 } : o));
    setupFake(t);
    fake.failOn({ table: "prepayment_item_obligations", action: "delete" });
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(false);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(true);
  });

  it("entfernt bei Soll 0 und räumt die 0-€-Sollzeile auf", async () => {
    const { removeMember } = await import("@/lib/actions/trip-members");
    const t = tables();
    t.transactions = [];
    t.transaction_participants = [];
    t.prepayment_item_obligations = t.prepayment_item_obligations.map((o) => (o.person_id === A ? { ...o, amount: 0 } : o));
    setupFake(t);
    const res = await removeMember(A_MEMBER_ROW, TRIP);
    expect(res.ok).toBe(true);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(false);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === A)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("replaceMember mit Posten", () => {
  function fdReplace(extra: Record<string, string> = {}): FormData {
    const f = new FormData();
    f.set("trip_id", TRIP);
    f.set("old_person_id", A);
    f.set("new_display_name", "Bea");
    f.set("new_person_id", B_NEW);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  }

  it("lehnt den Empfänger eines Postens ab (Payee-Guard), bevor irgendetwas geschrieben wird", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    setupFake(tables({ payee: A }));
    const res = await replaceMember({ status: "idle" }, fdReplace());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("weitere Zahlung");
    expect(fake.writes.filter((w) => w.table !== "audit_log")).toHaveLength(0);
  });

  it("H2: im Wechsel mitten im Törn bleibt ein Empfänger Crew UND Empfänger — kein Payee-Guard", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    setupFake(tables({ payee: A, start: "2026-09-01", end: "2026-12-31" }));
    const res = await replaceMember({ status: "idle" }, fdReplace({ repl_mode: "handover", handover_date: "2026-10-15" }));
    expect(res).toEqual({ status: "ok" });
    expect(fake.rows("prepayment_items")[0].payee_person_id).toBe(A);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(true);
  });

  it("L3: scheitert das Entfernen von A, werden die Posten-Zeilen auf A zurückgesetzt", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables();
    t.transactions.push({ id: "paid", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2099-01-11" });
    setupFake(t);
    fake.failOn({ table: "trip_members", action: "delete" });
    const res = await replaceMember({ status: "idle" }, fdReplace());
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === B_NEW)).toBe(false);
    expect(fake.rows("transaction_participants").find((p) => p.person_id === A)?.transaction_id).toBe(PROVIDER_TX);
    expect(fake.rows("transactions").find((x) => x.id === "paid")?.credit_from).toBe(A);
  });

  it("offene Posten-Selbstmeldung blockt den Wechsel", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables();
    t.transactions.push({ id: "pend", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: null, deleted_at: null, date: "2099-01-11" });
    setupFake(t);
    const res = await replaceMember({ status: "idle" }, fdReplace());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("auf Bestätigung");
    expect(fake.writes.filter((w) => w.table !== "audit_log")).toHaveLength(0);
  });

  it("Modus 1 (vor Törnbeginn): Soll, Anbieter-Anteil und Posten-Gutschrift wandern auf B, A verschwindet", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables();
    t.transactions.push({ id: "paid", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2099-01-11" });
    setupFake(t);
    const res = await replaceMember({ status: "idle" }, fdReplace());
    expect(res).toEqual({ status: "ok" });
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === B_NEW)?.amount).toBe(100);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === A)).toBe(false);
    expect(fake.rows("transaction_participants").find((p) => p.person_id === B_NEW)?.transaction_id).toBe(PROVIDER_TX);
    expect(fake.rows("transaction_participants").some((p) => p.person_id === A)).toBe(false);
    expect(fake.rows("transactions").find((x) => x.id === "paid")?.credit_from).toBe(B_NEW);
    expect(fake.rows("trip_members").some((m) => m.person_id === A)).toBe(false);
  });

  it("Modus 1: scheitert der letzte Buchungsspur-Check, ist am Posten noch nichts verändert", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables();
    t.transactions.push({ id: "a-item-credit", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2099-01-11" });
    setupFake(t);
    // Zwischen erstem und letztem Check bucht jemand parallel eine Ausgabe mit
    // paid_by = A (Hook auf den persons-Lookup in Schritt 7).
    let personsCalls = 0;
    fake.onFrom("persons", 3, () => {
      personsCalls += 1;
      fake.rows("transactions").push({ id: "late", trip_id: TRIP, type: "expense", item_id: null, tranche_id: null, paid_by: A, amount: 10, date: "2099-05-02", deleted_at: null });
    });
    const res = await replaceMember({ status: "idle" }, fdReplace());
    expect(personsCalls).toBe(1);
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === B_NEW)).toBe(false);
    expect(fake.rows("transaction_participants").some((p) => p.person_id === B_NEW)).toBe(false);
    expect(fake.rows("transactions").find((x) => x.id === "a-item-credit")?.credit_from).toBe(A);
  });

  it("Modus 1: hat die per E-Mail gefundene Person schon ein Posten-Soll, wird vor jedem Schreiben abgelehnt", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables();
    t.persons.push({ id: B_NEW, auth_user_id: null, display_name: "Bea" });
    t.persons_private.push({ person_id: B_NEW, email: "bea@example.test" });
    t.prepayment_item_obligations.push({ item_id: ITEM, trip_id: TRIP, person_id: B_NEW, amount: 0 });
    setupFake(t);
    const res = await replaceMember({ status: "idle" }, fdReplace({ new_email: "bea@example.test" }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("weiteren Zahlung");
    expect(fake.writes.filter((w) => w.table !== "audit_log")).toHaveLength(0);
  });

  it("Modus 2 (Wechsel mitten im Törn): A bleibt — und behält Posten-Soll, Anbieter-Anteil und Posten-Gutschrift (Ticket ist persönlich)", async () => {
    const { replaceMember } = await import("@/lib/actions/prepayments");
    const t = tables({ start: "2026-09-01", end: "2026-12-31" });
    t.transactions.push(
      { id: "item-paid", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2026-09-02" },
      { id: "kasse", trip_id: TRIP, type: "credit", item_id: null, tranche_id: null, credit_from: A, credit_to: SKIPPER, amount: 20, confirmed_at: "x", deleted_at: null, date: "2026-09-03" },
    );
    setupFake(t);
    const res = await replaceMember({ status: "idle" }, fdReplace({ repl_mode: "handover", handover_date: "2026-10-15" }));
    expect(res).toEqual({ status: "ok" });
    expect(fake.rows("trip_members").find((m) => m.person_id === A)?.on_board_to).toBe("2026-10-15");
    // Grill-Fund P1-1: ein Flugticket ist persönlich — B zahlt nicht A's Flüge.
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === A)?.amount).toBe(100);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === B_NEW)).toBe(false);
    expect(fake.rows("transaction_participants").find((p) => p.person_id === A)?.transaction_id).toBe(PROVIDER_TX);
    expect(fake.rows("transaction_participants").some((p) => p.person_id === B_NEW)).toBe(false);
    expect(fake.rows("transactions").find((x) => x.id === "item-paid")?.credit_from).toBe(A);
    expect(fake.rows("transactions").find((x) => x.id === "kasse")?.credit_from).toBe(A);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("Ghost-Merge mit Posten", () => {
  const REAL = "bbbbbbbb-0000-4000-8000-000000000007";

  function mergeSetup() {
    const t = tables();
    // PAYEE ist der Ghost. Seine Crew-Gutschrift-Eingänge + Selbstverrechnung.
    t.transactions.push(
      { id: "c-a", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: A, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2099-01-11" },
      { id: "c-self", trip_id: TRIP, type: "credit", item_id: ITEM, tranche_id: null, credit_from: PAYEE, credit_to: PAYEE, amount: 100, confirmed_at: "x", deleted_at: null, date: "2099-01-11" },
    );
    t.persons.push({ id: REAL, auth_user_id: null, display_name: "Real" });
    t.persons_private.push({ person_id: REAL, email: "real@example.test" });
    return t;
  }
  function fdMerge(): FormData {
    const f = new FormData();
    f.set("member_id", "bbbbbbbb-0000-4000-8000-0000000000a3");
    f.set("trip_id", TRIP);
    f.set("email", "real@example.test");
    return f;
  }

  it("hängt den Empfänger per move_item_payee um — direkt nach der Mitgliedschaft — und übernimmt das Posten-Soll", async () => {
    const { updateMember } = await import("@/lib/actions/trip-members");
    setupFake(mergeSetup());
    // move_item_payee nachbilden: Posten + credit_to atomar. Merkt sich, ob
    // die Mitgliedschaft beim Aufruf schon auf das echte Konto zeigte und ob
    // bis dahin keine Posten-Gutschrift per normalem UPDATE angefasst wurde.
    let realIsMemberAtMove = false;
    let itemCreditTouchedBeforeMove = false;
    fake.onRpc("move_item_payee", (args) => {
      const cur = fake.rows("prepayment_items").find((i) => i.id === args.p_item_id)!;
      if (cur.payee_person_id === args.p_new_payee) return { data: 0 }; // No-op-Probe (Review P1)
      realIsMemberAtMove = fake.rows("trip_members").some((m) => m.trip_id === TRIP && m.person_id === REAL);
      itemCreditTouchedBeforeMove = fake.rows("transactions").some((x) => x.item_id === ITEM && x.type === "credit" && x.credit_to === REAL);
      const item = fake.rows("prepayment_items").find((i) => i.id === args.p_item_id)!;
      const old = item.payee_person_id;
      item.payee_person_id = args.p_new_payee;
      for (const tx of fake.rows("transactions")) {
        if (tx.item_id === args.p_item_id && tx.type === "credit" && tx.credit_to === old) tx.credit_to = args.p_new_payee;
      }
      return { data: 1 };
    });

    const res = await updateMember({ status: "idle" }, fdMerge());
    expect(res).toEqual({ status: "ok" });

    // Reihenfolge (Grill-Fund P2-4): erst Mitgliedschaft, dann Empfänger —
    // und die Posten-Gutschriften nur über move_item_payee (sonst Trigger).
    // Erst die No-op-Probe (Review P1), dann der echte Wechsel.
    expect(fake.rpcCalls.filter((c) => c.name === "move_item_payee")).toEqual([
      { name: "move_item_payee", args: { p_item_id: ITEM, p_new_payee: PAYEE, p_move_credits: true } },
      { name: "move_item_payee", args: { p_item_id: ITEM, p_new_payee: REAL, p_move_credits: true } },
    ]);
    expect(realIsMemberAtMove).toBe(true);
    expect(itemCreditTouchedBeforeMove).toBe(false);
    expect(fake.rows("prepayment_items")[0].payee_person_id).toBe(REAL);
    expect(fake.rows("transactions").find((x) => x.id === "c-a")?.credit_to).toBe(REAL);
    expect(fake.rows("transactions").find((x) => x.id === "c-self")).toMatchObject({ credit_from: REAL, credit_to: REAL });
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === REAL)?.amount).toBe(100);
    expect(fake.rows("prepayment_item_obligations").some((o) => o.person_id === PAYEE)).toBe(false);
    expect(fake.rows("persons").some((p) => p.id === PAYEE)).toBe(false);
  });

  it("P1: fehlt move_item_payee (Migration nicht eingespielt), bricht der Merge VOR jedem Schreibschritt ab", async () => {
    const { updateMember } = await import("@/lib/actions/trip-members");
    setupFake(mergeSetup()); // bewusst KEIN onRpc("move_item_payee")
    const res = await updateMember({ status: "idle" }, fdMerge());
    expect(res.status).toBe("error");
    const mergeWrites = fake.writes.filter((w) => !["audit_log", "trip_members"].includes(w.table));
    expect(mergeWrites).toHaveLength(0);
    expect(fake.rows("trip_members").some((m) => m.person_id === PAYEE)).toBe(true);
  });

  it("P3: ist der Ghost Empfänger in einem ANDEREN Törn, wird vorab abgelehnt", async () => {
    const { updateMember } = await import("@/lib/actions/trip-members");
    const t = mergeSetup();
    t.prepayment_items.push({ id: "bbbbbbbb-0000-4000-8000-0000000000d9", trip_id: OTHER_TRIP, label: "X", total_amount: 10, payee_person_id: PAYEE, split_type: "gleichmaessig", sort_order: 0 });
    setupFake(t);
    const res = await updateMember({ status: "idle" }, fdMerge());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("anderen Törn");
    expect(fake.writes.filter((w) => !["audit_log", "trip_members"].includes(w.table))).toHaveLength(0);
  });

  it("Lesefehler beim Empfänger-Check → Abbruch OHNE jeden Schreibschritt", async () => {
    const { updateMember } = await import("@/lib/actions/trip-members");
    setupFake(mergeSetup());
    fake.failOn({ table: "prepayment_items", action: "select" });

    const res = await updateMember({ status: "idle" }, fdMerge());
    expect(res.status).toBe("error");
    // Nur das trip_members-Feld-Update von updateMember selbst (vor dem Merge)
    // + Audit; KEIN Schritt des Merges.
    const mergeWrites = fake.writes.filter((w) => !["audit_log", "trip_members"].includes(w.table));
    expect(mergeWrites).toHaveLength(0);
    expect(fake.rpcCalls.some((c) => c.name === "move_item_payee")).toBe(false);
  });
});
