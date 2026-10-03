import { describe, it, expect, vi, beforeEach } from "vitest";
import { planManualItemReminder, type ManualReminderItem } from "@/lib/prepayments/item-reminders";

const JAN = "aaaaaaaa-0000-4000-8000-000000000001";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000002";
const BEN = "aaaaaaaa-0000-4000-8000-000000000003";
const ITEM = "bbbbbbbb-0000-4000-8000-000000000001";
const TRIP = "cccccccc-0000-4000-8000-000000000001";

const item: ManualReminderItem = {
  id: ITEM, trip_id: TRIP, total_amount: 360, payee_person_id: JAN, providerPaid: 100,
  cells: [
    { person_id: JAN, soll: 120, paid: 120 },
    { person_id: ANNA, soll: 120, paid: 20 },
    { person_id: BEN, soll: 120, paid: 120 },
  ],
};

describe("planManualItemReminder", () => {
  it("Crew: Restbetrag + Soll", () => {
    const r = planManualItemReminder(item, ANNA);
    expect(r).toEqual({ ok: true, job: { type: "item_crew_3d", itemId: ITEM, tripId: TRIP, personId: ANNA, amount: 100, soll: 120 } });
  });
  it("Crew ohne offenen Betrag oder ohne Anteil: kein Job", () => {
    expect(planManualItemReminder(item, BEN)).toMatchObject({ ok: false });
    expect(planManualItemReminder(item, "dddddddd-0000-4000-8000-000000000009")).toMatchObject({ ok: false });
  });
  it("Empfänger: Übersicht ohne eigene Selbstverrechnung, Rest an den Anbieter", () => {
    const r = planManualItemReminder(item, JAN);
    expect(r.ok && r.job.type).toBe("item_payee_3d");
    expect(r.ok && r.job.overview).toEqual({ providerSoll: 360, crewPaid: 140, crewSoll: 240, providerPaid: 100, providerOpen: 260, ownOpen: 0 });
    expect(r.ok && r.job.amount).toBe(260);
  });
  it("Empfänger: alles an den Anbieter überwiesen → kein Job (Rundungsrand)", () => {
    expect(planManualItemReminder({ ...item, providerPaid: 359.996 }, JAN)).toMatchObject({ ok: false });
  });
});

// ── Action ────────────────────────────────────────────────────────────────
const sendItemReminderMail = vi.fn(async () => ({ ok: true as const }));
const requireAuth = vi.fn();
const getItems = vi.fn();
vi.mock("@/lib/email/send-item-reminder", () => ({ sendItemReminderMail: (...a: unknown[]) => (sendItemReminderMail as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/auth/authz", () => ({ requireSkipperAdminOrItemPayee: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/lib/auth/trip-state", () => ({ assertTripNotArchived: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/queries/prepayment-items", () => ({ getItems: (...a: unknown[]) => getItems(...a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Ostsee", trip_type: "sailing" }, error: null }) }) }) }) }),
}));

function fd(o: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
}
const base = { trip_id: TRIP, item_id: ITEM, person_id: ANNA };

describe("sendItemReminder (Action)", () => {
  beforeEach(() => {
    sendItemReminderMail.mockClear();
    requireAuth.mockReset().mockResolvedValue({ ok: true, tripId: TRIP });
    getItems.mockReset().mockResolvedValue([{ ...item, label: "Flüge", due_date: "2099-10-12", category_name: null }]);
  });

  it("verschickt die Crew-Mail mit dem Restbetrag", async () => {
    const { sendItemReminder } = await import("@/lib/actions/prepayment-item-reminder");
    expect(await sendItemReminder({ status: "idle" }, fd(base))).toEqual({ status: "ok" });
    const [, job, ctx] = sendItemReminderMail.mock.calls[0] as unknown as [unknown, { type: string; amount: number; personId: string }, { item: { dueDate: string } }];
    expect([job.type, job.amount, job.personId, ctx.item.dueDate]).toEqual(["item_crew_3d", 100, ANNA, "2099-10-12"]);
  });
  it("ohne Berechtigung: keine Mail", async () => {
    requireAuth.mockResolvedValue({ ok: false, message: "Keine Berechtigung." });
    const { sendItemReminder } = await import("@/lib/actions/prepayment-item-reminder");
    expect(await sendItemReminder({ status: "idle" }, fd(base))).toMatchObject({ status: "error" });
    expect(sendItemReminderMail).not.toHaveBeenCalled();
  });
  it("fremder Törn (trip_id passt nicht zum Posten): keine Mail", async () => {
    requireAuth.mockResolvedValue({ ok: true, tripId: "eeeeeeee-0000-4000-8000-000000000001" });
    const { sendItemReminder } = await import("@/lib/actions/prepayment-item-reminder");
    expect(await sendItemReminder({ status: "idle" }, fd(base))).toMatchObject({ status: "error" });
    expect(sendItemReminderMail).not.toHaveBeenCalled();
  });
  it("ohne Frist: Hinweis statt Mail", async () => {
    getItems.mockResolvedValue([{ ...item, label: "Flüge", due_date: null, category_name: null }]);
    const { sendItemReminder } = await import("@/lib/actions/prepayment-item-reminder");
    const r = await sendItemReminder({ status: "idle" }, fd(base));
    expect(r).toMatchObject({ status: "error" });
    expect(r.status === "error" && r.message).toContain("Frist");
    expect(sendItemReminderMail).not.toHaveBeenCalled();
  });
  it("Zustellfehler wird gemeldet", async () => {
    sendItemReminderMail.mockResolvedValueOnce({ ok: false, message: "Diese Person hat keine E-Mail-Adresse hinterlegt." } as never);
    const { sendItemReminder } = await import("@/lib/actions/prepayment-item-reminder");
    expect(await sendItemReminder({ status: "idle" }, fd(base))).toEqual({ status: "error", message: "Diese Person hat keine E-Mail-Adresse hinterlegt." });
  });
});
