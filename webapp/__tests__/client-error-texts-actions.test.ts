// Slice 11, Nachtrag: weitere Rückgabewege ohne rohen Postgres-Text
// (createTrip-Skipperanlage, Crew-Anlage/-Edit, resolve-pending, Cron-JSONs).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/auth/origin", async (orig) => ({ ...(await orig<object>()), resolveOrigin: vi.fn(() => "https://bordkasse.dieter.ms") }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireAdminOrTripCreator: vi.fn(),
  requireAdmin: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/auth/cron-auth", () => ({ verifyCronAuth: vi.fn().mockReturnValue({ ok: true }) }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/send-prepayment-reminder", () => ({ sendPrepaymentReminderMail: vi.fn() }));

import { createTrip } from "@/lib/actions/trips";
import { updateMember } from "@/lib/actions/trip-members";
import { requireSkipperOrAdmin, requireAdminOrTripCreator, isAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePendingReports } from "@/lib/prepayments/resolve-pending";
import { runItemReminders } from "@/lib/prepayments/item-reminder-cron";
import { GET } from "@/app/api/cron/prepayment-reminders/route";

const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000004";
const GHOST = "aaaaaaaa-0000-4000-8000-000000000005";

const PG_EMAIL = {
  message: 'duplicate key value violates unique constraint "persons_private_email_key" Key (email)=(fremd@example.test) already exists.',
  code: "23505",
};
function expectClean(text: string | undefined | null) {
  expect(text ?? "").not.toMatch(/duplicate key|constraint|persons_private|fremd@example|prepayment_items|v_prepayment/);
}

/** FIFO-Antworten pro Tabelle (wie in audit-payload-pii.test.ts). */
function queued(queues: Record<string, unknown[]>) {
  const consume = (t: string) => {
    const q = queues[t];
    if (!q || q.length === 0) throw new Error(`Keine Antwort mehr für ${t}`);
    return q.shift();
  };
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "update", "upsert", "delete", "is", "not", "or", "order", "gte", "lte"]) b[m] = () => b;
    b.insert = () => (table === "audit_log" ? Promise.resolve({ error: null }) : b);
    b.maybeSingle = () => Promise.resolve(consume(table));
    b.single = () => Promise.resolve(consume(table));
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve(consume(table)).then(ok);
    return b;
  };
  return { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: OWNER });
  vi.mocked(requireAdminOrTripCreator).mockResolvedValue({ ok: true, personId: OWNER });
  vi.mocked(isAdmin).mockResolvedValue(true);
});

describe("Rückgabewerte ohne Postgres-Rohtext", () => {
  it("createTrip (Skipperperson): persons_private-Insert-Fehler", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      queued({
        persons_private: [{ data: null, error: null }, { error: PG_EMAIL }],
        persons: [{ data: { id: GHOST }, error: null }],
      }) as never,
    );
    const fd = new FormData();
    fd.set("name", "Ostseetörn");
    fd.set("start_date", "2026-06-01");
    fd.set("end_date", "2026-06-10");
    fd.set("skipper_email", "fremd@example.test");
    const res = await createTrip({ status: "idle" }, fd);
    expect(res.status).toBe("error");
    if (res.status === "error") expectClean(res.message);
  });

  it("createTrip (Skipperperson): persons-Insert-Fehler", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      queued({
        persons_private: [{ data: null, error: null }],
        persons: [{ data: null, error: PG_EMAIL }],
      }) as never,
    );
    const fd = new FormData();
    fd.set("name", "Ostseetörn");
    fd.set("start_date", "2026-06-01");
    fd.set("end_date", "2026-06-10");
    fd.set("skipper_email", "fremd@example.test");
    const res = await createTrip({ status: "idle" }, fd);
    expect(res.status).toBe("error");
    if (res.status === "error") expectClean(res.message);
  });

  it("updateMember: Anzeigename-Update-Fehler", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      queued({
        trips: [{ data: { archived: false } }, { data: [] }],
        trip_members: [
          { data: { person_id: GHOST, persons: { auth_user_id: null, display_name: "Alt" } } },
          { data: [] },
          { error: null },
        ],
        persons_private: [{ data: null }],
        persons: [{ error: PG_EMAIL }],
      }) as never,
    );
    const fd = new FormData();
    fd.set("trip_id", TRIP);
    fd.set("member_id", MEMBER);
    fd.set("display_name", "Neu");
    fd.set("email", "");
    const res = await updateMember({ status: "idle" }, fd);
    expect(res.status).toBe("error");
    expectClean(res.status === "error" ? res.message : "");
  });

  it("resolvePendingReports: DB-Fehler liefert festen Text", async () => {
    vi.mocked(createAdminClient).mockReturnValue(queued({ transactions: [{ data: null, error: PG_EMAIL }] }) as never);
    const res = await resolvePendingReports(createAdminClient() as never, {
      tripId: TRIP,
      personId: MEMBER,
      pool: { plan: true },
      ids: [GHOST],
    });
    expect(res.error).toBeTruthy();
    expectClean(res.error);
  });

  it("Posten-Cron: Ladefehler nennt keine Tabelle im JSON", async () => {
    const res = await runItemReminders(queued({ prepayment_items: [{ data: null, error: PG_EMAIL }] }) as never, "2026-06-01");
    expect(res.failed).toBe(1);
    expectClean(JSON.stringify(res));
  });

  it("prepayment-reminders-Cron: Tranchen-Abfragefehler ohne Rohtext", async () => {
    vi.mocked(createAdminClient).mockReturnValue(queued({ prepayment_tranches: [{ data: null, error: PG_EMAIL }] }) as never);
    const res = await GET({ headers: new Headers() } as never);
    expectClean(JSON.stringify(await res.json()));
  });
});
