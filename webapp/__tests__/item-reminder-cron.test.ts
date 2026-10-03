// Posten-Erinnerungen im täglichen Anzahlungs-Cron (PR5, Migration 0061).
//
// Läuft gegen den filternden In-Memory-Fake: geprüft wird, welche Mails
// WIRKLICH rausgehen und was im Dedup-Log landet — inklusive des echten
// Senders (lib/email/send-item-reminder.ts), nur `sendMail` ist gemockt.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/cron-auth", () => ({ verifyCronAuth: vi.fn().mockReturnValue({ ok: true }) }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/send", () => ({ sendMail: vi.fn() }));
vi.mock("@/lib/email/send-prepayment-reminder", () => ({ sendPrepaymentReminderMail: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "@/app/api/cron/prepayment-reminders/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/send";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { sendPrepaymentReminderMail } from "@/lib/email/send-prepayment-reminder";
import { addDays } from "@/lib/prepayments/dates";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";
import { ITEM_TIME_BUDGET_MS, runItemReminders, safeMailErrorMessage } from "@/lib/prepayments/item-reminder-cron";

const mockedAdmin = vi.mocked(createAdminClient);
const mockedSendMail = vi.mocked(sendMail);
const mockedPush = vi.mocked(sendPushToPersons);
const mockedTrancheMail = vi.mocked(sendPrepaymentReminderMail);

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const PAYEE = "aaaaaaaa-0000-4000-8000-000000000002";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000003";
const BEN = "aaaaaaaa-0000-4000-8000-000000000004";
const ITEM = "aaaaaaaa-0000-4000-8000-0000000000d1";
const CAT = "aaaaaaaa-0000-4000-8000-0000000000c1";
const TRANCHE = "aaaaaaaa-0000-4000-8000-0000000000b1";

const today = () => new Date().toISOString().slice(0, 10);

function tables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    prepayment_tranches: [],
    trips: [
      { id: TRIP, name: "Ostsee <b>", trip_type: "sailing", skipper_id: PAYEE, end_date: addDays(today(), 60), archived: false, retention_purged_at: null },
    ],
    prepayment_items: [
      {
        id: ITEM, trip_id: TRIP, category_id: CAT, label: "Flüge", total_amount: 300,
        due_date: addDays(today(), 2), payee_person_id: PAYEE,
      },
    ],
    prepayment_item_obligations: [
      { item_id: ITEM, trip_id: TRIP, person_id: PAYEE, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: BEN, amount: 100 },
    ],
    v_prepayment_item_payments: [],
    v_prepayment_item_pending: [],
    transactions: [],
    prepayment_item_reminder_log: [],
    trip_categories: [{ id: CAT, trip_id: TRIP, name: "An-/Abreise" }],
    persons: [
      { id: PAYEE, display_name: "Paula" },
      { id: ANNA, display_name: "Anna" },
      { id: BEN, display_name: "Ben" },
    ],
    persons_private: [
      { person_id: PAYEE, email: "paula@example.test" },
      { person_id: ANNA, email: "anna@example.test" },
      { person_id: BEN, email: "ben@example.test" },
    ],
    ...extra,
  } as Record<string, Row[]>;
}

let fake: ReturnType<typeof createFakeSupabase>;
function setup(t: Record<string, Row[]>) {
  fake = createFakeSupabase(t);
  mockedAdmin.mockReturnValue(fake.client as never);
  return fake;
}

async function run() {
  const res = await GET(new Request("https://x/api/cron/prepayment-reminders", { headers: { authorization: "Bearer t" } }) as never);
  return res.json();
}

const mailsTo = () => mockedSendMail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();

beforeEach(() => {
  vi.clearAllMocks();
  mockedSendMail.mockResolvedValue({ ok: true } as never);
});

describe("Posten-Erinnerungen im Cron", () => {
  it("2 Tage vor Fälligkeit: Crew (ohne Empfänger) + Empfänger-Übersicht, Log + Push je Job", async () => {
    setup(tables());
    const json = await run();
    expect(json.items).toEqual({ processed: 3, sent: 3, skipped: 0, failed: 0 });
    expect(json.sent).toBe(3);
    expect(mailsTo()).toEqual(["anna@example.test", "ben@example.test", "paula@example.test"]);
    const log = fake.rows("prepayment_item_reminder_log").map((r) => `${r.person_id}:${r.reminder_type}`).sort();
    expect(log).toEqual([`${ANNA}:item_crew_3d`, `${BEN}:item_crew_3d`, `${PAYEE}:item_payee_3d`].sort());
    expect(fake.rows("prepayment_item_reminder_log").every((r) => r.trip_id === TRIP && r.item_id === ITEM)).toBe(true);
    expect(mockedPush).toHaveBeenCalledTimes(3);

    const annaMail = mockedSendMail.mock.calls.map((c) => c[0] as { to: string; html: string }).find((m) => m.to === "anna@example.test")!;
    expect(annaMail.html).toContain("Paula"); // an wen zahlen
    expect(annaMail.html).toContain("Ostsee &lt;b&gt;"); // Törnname escaped
    expect(annaMail.html).toContain("An-/Abreise: Flüge");
  });

  it("Crew-Mail nennt die Crewfrist (3 Tage vor Anbieter-Frist)", async () => {
    const t = tables();
    t.prepayment_items[0].due_date = addDays(today(), 5); // nur Crew-Fenster
    setup(t);
    const json = await run();
    expect(json.items.sent).toBe(2); // Empfänger erst ab 3 Tagen
    const [y, m, d] = addDays(today(), 2).split("-");
    const crewDue = `${Number(d)}.${Number(m)}.${y}`;
    for (const c of mockedSendMail.mock.calls) expect((c[0] as { html: string }).html).toContain(crewDue);
  });

  it("Clamp: 1 Tag vor Anbieter-Frist liegt die Crewfrist nicht in der Vergangenheit, sondern heute", async () => {
    const t = tables();
    t.prepayment_items[0].due_date = addDays(today(), 1);
    setup(t);
    await run();
    const [y, m, d] = today().split("-");
    const crewDue = `${Number(d)}.${Number(m)}.${y}`;
    const anna = mockedSendMail.mock.calls.map((c) => c[0] as { to: string; html: string }).find((x) => x.to === "anna@example.test")!;
    expect(anna.html).toMatch(new RegExp(`Bis wann[\\s\\S]*?<strong>${crewDue.replace(/\./g, "\\.")}</strong>`));
  });

  it("zweiter Lauf am selben Tag verschickt nichts (Dedup)", async () => {
    setup(tables());
    await run();
    mockedSendMail.mockClear();
    const json = await run();
    expect(json.items.processed).toBe(0);
    expect(mockedSendMail).not.toHaveBeenCalled();
  });

  it("keine E-Mail hinterlegt → skipped (kein Fehler), kein Log", async () => {
    setup(tables({ persons_private: [{ person_id: PAYEE, email: "paula@example.test" }, { person_id: BEN, email: "ben@example.test" }] }));
    const json = await run();
    expect(json.items).toEqual({ processed: 3, sent: 2, skipped: 1, failed: 0 });
    expect(fake.rows("prepayment_item_reminder_log").some((r) => r.person_id === ANNA)).toBe(false);
  });

  it("Zustellungsfehler → failed, kein Log (nächster Lauf versucht es erneut); übrige Jobs laufen weiter", async () => {
    setup(tables());
    mockedSendMail.mockImplementation(async (m: { to: string }) =>
      (m.to === "anna@example.test" ? { ok: false, error: "SMTP timeout" } : { ok: true }) as never,
    );
    const json = await run();
    expect(json.items).toEqual({ processed: 3, sent: 2, skipped: 0, failed: 1 });
    expect(fake.rows("prepayment_item_reminder_log").some((r) => r.person_id === ANNA)).toBe(false);
    expect(json.errors.some((e: { kind: string }) => e.kind === "failed")).toBe(true);
  });

  it("Lesefehler beim Personen-Lookup ist failed, nicht skipped", async () => {
    const f = setup(tables());
    f.failOn({ table: "persons", action: "select", nth: 1 });
    const json = await run();
    expect(json.items.failed).toBe(1);
    expect(json.items.skipped).toBe(0);
  });

  it("Dedup-Log-Insert scheitert → failed (Mail ist raus); 23505 ist harmlos", async () => {
    let f = setup(tables());
    f.failOn({ table: "prepayment_item_reminder_log", action: "insert", error: { code: "23503", message: "fk" } });
    let json = await run();
    expect(json.items.sent).toBe(3);
    expect(json.items.failed).toBe(1);

    f = setup(tables());
    f.failOn({ table: "prepayment_item_reminder_log", action: "insert", error: { code: "23505", message: "dup" } });
    json = await run();
    expect(json.items.sent).toBe(3);
    expect(json.items.failed).toBe(0);
  });

  it("Pending-Awareness + bezahlt + Anbieter voll bezahlt → nichts", async () => {
    setup(
      tables({
        v_prepayment_item_pending: [{ item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 }],
        v_prepayment_item_payments: [{ item_id: ITEM, trip_id: TRIP, person_id: BEN, paid_amount: 100 }],
        transactions: [{ id: "tx1", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 300, deleted_at: null }],
      }),
    );
    const json = await run();
    expect(json.items.processed).toBe(0);
    expect(mockedSendMail).not.toHaveBeenCalled();
  });

  it("gelöschte Anbieter-Zahlung zählt nicht als bezahlt", async () => {
    setup(tables({ transactions: [{ id: "tx1", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 300, deleted_at: "x" }] }));
    const json = await run();
    expect(mailsTo()).toContain("paula@example.test");
    expect(json.items.sent).toBe(3);
  });

  it("archivierter Törn → keine Erinnerung", async () => {
    const t = tables();
    t.trips[0].archived = true;
    setup(t);
    expect((await run()).items.processed).toBe(0);
  });

  it("FAIL-SOFT: fehlt die Log-Tabelle (App vor Migration), geht keine Posten-Mail raus, Tranchen laufen weiter", async () => {
    const f = setup(
      tables({
        prepayment_tranches: [{ id: TRANCHE, trip_id: TRIP, label: "1. Anzahlung", due_date: addDays(today(), 5), percent: 100 }],
        prepayment_plan: [{ trip_id: TRIP, advancer_person_id: PAYEE, total_amount: 1000 }],
        prepayment_obligations: [{ trip_id: TRIP, person_id: ANNA, total_amount: 500 }],
        v_prepayment_payments: [],
        v_prepayment_pending: [],
        prepayment_reminder_log: [],
      }),
    );
    f.failOn({ table: "prepayment_item_reminder_log", action: "select", error: { code: "42P01", message: 'relation "prepayment_item_reminder_log" does not exist' } });
    mockedTrancheMail.mockResolvedValue({ ok: true });

    const json = await run();
    expect(json.ok).toBe(true);
    expect(json.items).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 1 });
    expect(json.tranches.sent).toBe(1);
    expect(json.failed).toBe(1);
    expect(mockedSendMail).not.toHaveBeenCalled();
  });

  it("FAIL-SOFT: fehlt die Posten-Tabelle, läuft der Lauf trotzdem mit 200 durch", async () => {
    const f = setup(tables());
    f.failOn({ table: "prepayment_items", action: "select", error: { code: "42P01", message: "missing" } });
    const res = await GET(new Request("https://x", { headers: { authorization: "Bearer t" } }) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).items.failed).toBe(1);
  });
});

describe("Zeitbudget + Reihenfolge (Review P2)", () => {
  const trancheTables = () =>
    tables({
      prepayment_tranches: [{ id: TRANCHE, trip_id: TRIP, label: "1. Anzahlung", due_date: addDays(today(), 5), percent: 100 }],
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: PAYEE, total_amount: 1000 }],
      prepayment_obligations: [{ trip_id: TRIP, person_id: ANNA, total_amount: 500 }],
      v_prepayment_payments: [],
      v_prepayment_pending: [],
      prepayment_reminder_log: [],
    });

  it("hängender Posten-Versand: Abbruch nach Budget mit time_budget, kein Log, Rest nicht versucht", async () => {
    setup(tables());
    mockedSendMail.mockImplementation(() => new Promise(() => {}) as never);
    const res = await runItemReminders(fake.client as never, today(), { budgetMs: 20 });
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.errors).toEqual([expect.objectContaining({ type: "time_budget", kind: "failed" })]);
    expect(mockedSendMail).toHaveBeenCalledTimes(1);
    expect(fake.rows("prepayment_item_reminder_log")).toHaveLength(0);
  });

  it("Budget schon verbraucht → kein Versand, time_budget-Vermerk", async () => {
    setup(tables());
    const res = await runItemReminders(fake.client as never, today(), { budgetMs: -1 });
    expect(mockedSendMail).not.toHaveBeenCalled();
    expect(res.errors[0].type).toBe("time_budget");
  });

  it("Route: hängender Posten-Versand verhindert die Tranchen-Erinnerungen nicht (Tranchen zuerst)", async () => {
    vi.useFakeTimers();
    try {
      setup(trancheTables());
      mockedTrancheMail.mockResolvedValue({ ok: true });
      mockedSendMail.mockImplementation(() => new Promise(() => {}) as never);
      const pending = run();
      await vi.advanceTimersByTimeAsync(ITEM_TIME_BUDGET_MS + 1_000);
      const json = await pending;
      expect(mockedTrancheMail).toHaveBeenCalledTimes(1);
      // Reihenfolge: Tranche vor dem ersten Posten-Versand.
      expect(mockedTrancheMail.mock.invocationCallOrder[0]).toBeLessThan(mockedSendMail.mock.invocationCallOrder[0]);
      expect(json.tranches.sent).toBe(1);
      expect(json.items.failed).toBe(1);
      expect(json.errors.some((e: { type: string }) => e.type === "time_budget")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Route: scheitert die Tranchen-Query, läuft der Posten-Teil trotzdem (500 mit items)", async () => {
    const f = setup(tables());
    f.failOn({ table: "prepayment_tranches", action: "select", error: { message: "boom" } });
    const res = await GET(new Request("https://x", { headers: { authorization: "Bearer t" } }) as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.items.sent).toBe(3);
  });

  it("Item-Mails nutzen knappe SMTP-Timeouts (nur für diesen Aufruf)", async () => {
    setup(tables());
    await run();
    const opts = mockedSendMail.mock.calls[0][1] as { connectionTimeoutMs: number; socketTimeoutMs: number };
    expect(opts.connectionTimeoutMs).toBeGreaterThan(0);
    expect(opts.socketTimeoutMs).toBeGreaterThan(0);
  });
});

describe("Keine PII im Cron-JSON (Review P4)", () => {
  it("SMTP-Fehler: errors[].message ohne Adresse/Rohtext, nur Code", async () => {
    setup(tables());
    mockedSendMail.mockResolvedValue({
      ok: false,
      error: "Mail-Versand fehlgeschlagen: 550 5.1.1 <anna@example.test>: Recipient address rejected",
      code: "EENVELOPE",
      responseCode: 550,
    } as never);
    const json = await run();
    const text = JSON.stringify(json);
    expect(text).not.toContain("@example.test");
    expect(text).not.toContain("Recipient address rejected");
    expect(json.errors[0].message).toBe("Mail-Zustellung fehlgeschlagen (EENVELOPE 550)");
  });

  it("safeMailErrorMessage ohne Code → neutraler Text", () => {
    expect(safeMailErrorMessage({})).toBe("Mail-Zustellung fehlgeschlagen");
  });
});
