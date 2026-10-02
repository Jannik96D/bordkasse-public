// M1 (PR4a-Review) end-to-end in announceSettlement: der Mail-Saldo ist der
// Bordkasse-Saldo (passt zum Zahlungsplan), der Posten-Anteil steht getrennt.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ requireSkipperOrAdmin: vi.fn(async () => ({ ok: true, personId: "s" })), requireMember: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn(async () => ({ id: "s", display_name: "S" })) }));
vi.mock("@/lib/email/send", () => ({ sendMails: vi.fn(async (m: unknown[]) => m.map(() => ({ ok: true }))) }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/queries/balances", () => ({
  // Gesamt: Anna −130 (davon 100 offen für Flüge), Ben +130.
  getBalances: vi.fn(async () => [
    { person_id: "anna", display_name: "Anna", balance: -130 },
    { person_id: "ben", display_name: "Ben", balance: 130 },
  ]),
  getBordkasseOnlyBalances: vi.fn(async () => [
    { person_id: "anna", balance: -30 },
    { person_id: "ben", balance: 30 },
  ]),
  getSimplifiedDebts: vi.fn(async () => [
    { from_person_id: "anna", to_person_id: "ben", from_name: "Anna", to_name: "Ben", amount: 30 },
  ]),
}));

import { announceSettlement } from "@/lib/actions/settlement";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMails } from "@/lib/email/send";
import { createFakeSupabase } from "./helpers/fake-supabase";

describe("announceSettlement — Saldo vs. Zahlungsplan", () => {
  it("nennt 30 € Bordkasse-Saldo (= Zahlungsplan) und 100 € Posten getrennt", async () => {
    const fake = createFakeSupabase({
      trips: [{ id: "t", name: "T", start_date: "2026-06-01", end_date: "2026-06-10", settlement_announced_at: null, trip_type: "sailing" }],
      trip_members: [{ trip_id: "t", person_id: "anna" }, { trip_id: "t", person_id: "ben" }],
      persons_private: [{ person_id: "anna", email: "anna@example.test" }],
      audit_log: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    const res = await announceSettlement("t");
    expect(res.ok).toBe(true);
    const mails = vi.mocked(sendMails).mock.calls[0][0] as { text: string }[];
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("Du zahlst noch 30,00");
    expect(mails[0].text).toContain("Du zahlst 30,00");
    expect(mails[0].text).toContain("weiteren Posten zusätzlich −100,00");
    expect(mails[0].text).not.toContain("130");
  });
});

describe("announceSettlement — fail-loud bei leerer/fehlerhafter Bilanz (Delta 4)", () => {
  it("bricht ab, wenn die Bilanz leer ist, obwohl es Crew gibt", async () => {
    const q = await import("@/lib/queries/balances");
    vi.mocked(q.getBalances).mockResolvedValueOnce([]);
    vi.mocked(sendMails).mockClear();
    const fake = createFakeSupabase({
      trips: [{ id: "t", name: "T", start_date: "2026-06-01", end_date: "2026-06-10", settlement_announced_at: null, trip_type: "sailing" }],
      trip_members: [{ trip_id: "t", person_id: "anna" }],
      persons_private: [{ person_id: "anna", email: "anna@example.test" }],
      audit_log: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    const res = await announceSettlement("t");
    expect(res.ok).toBe(false);
    expect(sendMails).not.toHaveBeenCalled();
    expect(fake.rows("trips")[0].settlement_announced_at).toBeNull();
  });

  it("bricht ab, wenn die Bilanz nicht geladen werden kann", async () => {
    const q = await import("@/lib/queries/balances");
    vi.mocked(q.getBordkasseOnlyBalances).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(sendMails).mockClear();
    const fake = createFakeSupabase({
      trips: [{ id: "t", name: "T", start_date: "2026-06-01", end_date: "2026-06-10", settlement_announced_at: null, trip_type: "sailing" }],
      trip_members: [{ trip_id: "t", person_id: "anna" }],
      audit_log: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    const res = await announceSettlement("t");
    expect(res.ok).toBe(false);
    expect(sendMails).not.toHaveBeenCalled();
  });
});
