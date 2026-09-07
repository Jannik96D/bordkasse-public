// Fund 3 (Sanierungsplan 2026-09, PR 6): send-first bleibt bewusst
// unverändert (prepayment_reminder_log hat keinen "pending"-Zustand — ein
// claim-first-Ansatz würde einen echten Fehlschlag dauerhaft unterdrücken).
// Der Fix ist, dass ein tatsächlicher Fehlschlag (Mail-Versand ODER
// Dedup-Log-Insert) im JSON-Response als `failed` GEZÄHLT wird, getrennt
// von `skipped` (= Job war schlicht nicht zutreffend, kein Fehler) —
// analog zum Purge-Cron, der `purged`/`failed` getrennt zurückgibt.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/cron-auth", () => ({
  verifyCronAuth: vi.fn().mockReturnValue({ ok: true }),
}));
vi.mock("@/lib/notify/web-push", () => ({
  sendPushToPersons: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email/send-prepayment-reminder", () => ({
  sendPrepaymentReminderMail: vi.fn(),
}));

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000010";
const TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const CREW_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000012";
const SKIPPER_ID = "aaaaaaaa-0000-4000-8000-000000000013";

function isoInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function makeSupabaseMock(opts: { logInsertError?: { code: string; message: string } | null }) {
  const dueDate = isoInDays(5); // innerhalb des crew_3d-Fensters (<=6 Tage), außerhalb advancer_3d (<=3)

  const tranches = [
    { id: TRANCHE_ID, trip_id: TRIP_ID, label: "1. Anzahlung", due_date: dueDate, percent: 50 },
  ];
  const trips = [{ id: TRIP_ID, name: "Test-Törn", skipper_id: SKIPPER_ID, end_date: isoInDays(30) }];
  const plans = [{ trip_id: TRIP_ID, advancer_person_id: SKIPPER_ID, total_amount: 1000 }];
  const obligations = [{ trip_id: TRIP_ID, person_id: CREW_PERSON_ID, total_amount: 500 }];

  let insertCalls = 0;

  return {
    from(table: string) {
      switch (table) {
        case "prepayment_tranches":
          return {
            select: () => ({
              gte: () => ({
                lte: () => Promise.resolve({ data: tranches, error: null }),
              }),
            }),
          };
        case "trips":
          return { select: () => ({ in: () => Promise.resolve({ data: trips }) }) };
        case "prepayment_plan":
          return { select: () => ({ in: () => Promise.resolve({ data: plans }) }) };
        case "prepayment_obligations":
          return { select: () => ({ in: () => Promise.resolve({ data: obligations }) }) };
        case "v_prepayment_payments":
          return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) };
        case "v_prepayment_pending":
          return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) };
        case "transactions":
          return {
            select: () => ({
              in: () => ({
                eq: () => ({
                  is: () => ({
                    not: () => Promise.resolve({ data: [] }),
                  }),
                }),
              }),
            }),
          };
        case "prepayment_reminder_log":
          return {
            select: () => ({ in: () => Promise.resolve({ data: [] }) }),
            insert: () => {
              insertCalls++;
              return Promise.resolve({ error: opts.logInsertError ?? null });
            },
          };
        default:
          throw new Error(`unerwartete Tabelle im Test: ${table}`);
      }
    },
    get insertCalls() {
      return insertCalls;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { sendPrepaymentReminderMail } from "@/lib/email/send-prepayment-reminder";
import { GET } from "@/app/api/cron/prepayment-reminders/route";

const mockedAdminClient = vi.mocked(createAdminClient);
const mockedSendReminder = vi.mocked(sendPrepaymentReminderMail);

function makeRequest(): Request {
  return new Request("https://bordkasse.example/api/cron/prepayment-reminders", {
    headers: { authorization: "Bearer test" },
  }) as never;
}

describe("GET /api/cron/prepayment-reminders — failed getrennt von skipped zählen (Fund 3)", () => {
  beforeEach(() => {
    mockedAdminClient.mockReset();
    mockedSendReminder.mockReset();
  });

  it("zählt einen echten Mail-Zustellungsfehler als `failed`, nicht als `skipped`", async () => {
    mockedAdminClient.mockReturnValue(makeSupabaseMock({ logInsertError: null }) as never);
    mockedSendReminder.mockResolvedValue({
      ok: false,
      message: "Mail-Versand fehlgeschlagen: SMTP timeout",
      reason: "send_failed",
    });

    const res = await GET(makeRequest() as never);
    const json = await res.json();

    expect(json.processed).toBe(1);
    expect(json.failed).toBe(1);
    expect(json.skipped).toBe(0);
    expect(json.sent).toBe(0);
  });

  it("zählt eine nicht-zutreffende Person (z.B. keine E-Mail hinterlegt) als `skipped`, nicht als `failed`", async () => {
    mockedAdminClient.mockReturnValue(makeSupabaseMock({ logInsertError: null }) as never);
    mockedSendReminder.mockResolvedValue({
      ok: false,
      message: "Diese Person hat keine E-Mail-Adresse hinterlegt.",
    });

    const res = await GET(makeRequest() as never);
    const json = await res.json();

    expect(json.processed).toBe(1);
    expect(json.failed).toBe(0);
    expect(json.skipped).toBe(1);
  });

  it("zählt einen fehlgeschlagenen Dedup-Log-Insert als `failed`, obwohl die Mail zugestellt wurde", async () => {
    mockedAdminClient.mockReturnValue(
      makeSupabaseMock({ logInsertError: { code: "23503", message: "fk violation" } }) as never,
    );
    mockedSendReminder.mockResolvedValue({ ok: true });

    const res = await GET(makeRequest() as never);
    const json = await res.json();

    expect(json.sent).toBe(1);
    expect(json.failed).toBe(1);
  });

  it("zählt eine Unique-Violation (paralleler Cron-Lauf) NICHT als failed", async () => {
    mockedAdminClient.mockReturnValue(
      makeSupabaseMock({ logInsertError: { code: "23505", message: "duplicate key" } }) as never,
    );
    mockedSendReminder.mockResolvedValue({ ok: true });

    const res = await GET(makeRequest() as never);
    const json = await res.json();

    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
  });
});
