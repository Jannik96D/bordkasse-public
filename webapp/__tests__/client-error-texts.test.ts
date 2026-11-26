// Slice 11 (Sicherheitsrunde 2026-11): keine rohen Postgres-/SMTP-Meldungen
// in Rückgabewerten an den Client. Der SMTP-Fehler von nodemailer nennt meist
// die Empfängeradresse — an einen Vorstrecker, der Crew-Adressen sonst nicht
// sehen darf.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const ADRESSE = "anna.geheim@example.test";
const SMTP_ROH = `550 5.1.1 <${ADRESSE}>: Recipient address rejected`;

const sendMailMock = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock, close: vi.fn() }) },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { sendMail } from "@/lib/email/send";
import { sendPrepaymentReminderMail } from "@/lib/email/send-prepayment-reminder";
import { updateProfile } from "@/app/profile/actions";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { dbErr, safeMailErrorMessage } from "@/lib/errors";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSON = "aaaaaaaa-0000-4000-8000-000000000002";
const ADVANCER = "aaaaaaaa-0000-4000-8000-000000000003";

/** Minimal-Fake: jede Kette endet in einer Antwort pro Tabelle. */
type Res = { data?: unknown; error?: { message: string; code?: string } | null };
function fakeDb(tables: Record<string, Res | Res[]>) {
  const calls: Record<string, number> = {};
  return {
    from(table: string) {
      const spec = tables[table];
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const pick = Array.isArray(spec) ? (spec[n - 1] ?? spec[spec.length - 1]) : spec;
      const res = { data: null, error: null, ...(pick ?? {}) };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "update", "is", "in", "neq"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve(res);
      chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, ko);
      return chain;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Mail-Fehler enthalten keine Empfängeradresse", () => {
  it("sendMail: Fehlertext trägt nur Codes", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error(SMTP_ROH), { code: "EENVELOPE", responseCode: 550 }));
    const r = await sendMail({ to: ADRESSE, subject: "x", html: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(ADRESSE);
      expect(r.error).not.toContain("Recipient");
      expect(r.error).toBe(safeMailErrorMessage({ code: "EENVELOPE", responseCode: 550 }));
    }
  });

  it("sendPrepaymentReminderMail (Crew-Pfad): Rückgabe ohne Adresse", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error(SMTP_ROH), { code: "EENVELOPE", responseCode: 550 }));
    vi.mocked(createAdminClient).mockReturnValue(
      fakeDb({
        trips: { data: { name: "Ostsee", skipper_id: ADVANCER, trip_type: "sailing" } },
        prepayment_plan: { data: { wero_id: null, advancer_person_id: ADVANCER, total_amount: 1000 } },
        persons: { data: { display_name: "Anna" } },
        persons_private: { data: { email: ADRESSE } },
        prepayment_obligations: { data: { total_amount: 500 } },
        prepayment_tranches: { data: [{ id: "t1", due_date: "2099-01-01", label: "Endzahlung", percent: 100 }] },
        v_prepayment_payments: { data: [] },
      }) as never,
    );
    const r = await sendPrepaymentReminderMail({ tripId: TRIP, personId: PERSON });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("send_failed");
      expect(r.message).not.toContain(ADRESSE);
      expect(r.message).not.toContain("Recipient");
    }
  });
});

describe("Postgres-Fehler → generische Meldung", () => {
  const PG = { message: 'duplicate key value violates unique constraint "persons_pkey"', code: "23505" };

  it("dbErr gibt nur den Fallback zurück und loggt den Rohtext", () => {
    expect(dbErr(PG, "Fallback.")).toBe("Fallback.");
    expect(console.error).toHaveBeenCalled();
  });

  it("updateProfile: DB-Fehler erscheint nicht im Rückgabewert", async () => {
    vi.mocked(getCurrentPerson).mockResolvedValue({ id: PERSON } as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({ persons: [{ data: { is_alcoholic: true } }, { data: null, error: PG }] }) as never);
    const fd = new FormData();
    fd.set("display_name", "Anna");
    fd.set("is_alcoholic", "on");
    const r = await updateProfile({ status: "idle" } as never, fd);
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.message).not.toContain("persons_pkey");
      expect(r.message).not.toContain("duplicate key");
    }
  });
});
