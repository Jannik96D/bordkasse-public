// Regression zu Fund 8 (Code-Review 2026-08): resendSettlement behauptete in
// Kommentar + README/CLAUDE.md einen Spam-Schutz über `changes_pending_since`,
// prüfte das Flag aber nie als Guard — es wurde nur als Zeitstempel für die
// Audit-Zusammenfassung gelesen. Jedes Crewmitglied (requireMember reicht)
// konnte die Update-Mail an die gesamte Crew beliebig oft auslösen, solange
// nur `settlement_announced_at` gesetzt war. Dieser Test beweist, dass ein
// fehlendes `changes_pending_since` den Versand jetzt tatsächlich blockiert.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendMails: vi.fn() }));

import { resendSettlement } from "@/lib/actions/settlement";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMails } from "@/lib/email/send";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireMember = vi.mocked(requireMember);
const mockedAdminClient = vi.mocked(createAdminClient);
const mockedSendMails = vi.mocked(sendMails);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000002";

function makeSupabase(tripRow: Record<string, unknown> | null) {
  const make = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.maybeSingle = () => Promise.resolve({ data: tripRow });
    return b;
  };
  return { from: () => make() };
}

describe("resendSettlement — changes_pending_since als echter Guard (Fund 8)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireMember.mockReset();
    mockedAdminClient.mockReset();
    mockedSendMails.mockReset();
    mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew" } as never);
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
  });

  it("lehnt den Resend ab, wenn seit der letzten Abrechnung nichts geändert wurde", async () => {
    mockedAdminClient.mockReturnValue(
      makeSupabase({
        id: TRIP_ID,
        name: "Test-Törn",
        start_date: "2026-06-01",
        end_date: "2026-06-10",
        settlement_announced_at: "2026-06-11T10:00:00Z",
        changes_pending_since: null, // ← nichts hat sich geändert
        last_settlement_resend_at: null,
        trip_type: "sailing",
      }) as never,
    );

    const res = await resendSettlement(TRIP_ID);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("nichts geändert");
    // Der entscheidende Beweis: die Mail-Kaskade darf gar nicht erst starten.
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("weist ab, wenn noch nie eine initiale Abrechnung verschickt wurde", async () => {
    mockedAdminClient.mockReturnValue(
      makeSupabase({
        id: TRIP_ID,
        name: "Test-Törn",
        start_date: "2026-06-01",
        end_date: "2026-06-10",
        settlement_announced_at: null,
        changes_pending_since: null,
        last_settlement_resend_at: null,
        trip_type: "sailing",
      }) as never,
    );

    const res = await resendSettlement(TRIP_ID);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("noch keine Abrechnung");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });
});
