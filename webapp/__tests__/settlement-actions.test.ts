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
vi.mock("@/lib/queries/balances", () => ({
  getBalances: vi.fn().mockResolvedValue([]),
  getSimplifiedDebts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));

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
        // ← bereits erfolgreich zugestellt, siehe Fund 2 (PR 6): nur wenn
        // diese Spalte NULL ist, greift die Ausnahme "Erstversand fehlgeschlagen".
        settlement_mail_sent_at: "2026-06-11T10:00:05Z",
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

// Fund 2 (Sanierungsplan 2026-09, PR 6): settlement_announced_at (das GATE
// für Häkchen/Purge/Checkliste) und settlement_mail_sent_at (nur gesetzt bei
// tatsächlich erfolgreicher Zustellung) sind zwei unterschiedliche Dinge.
// Schlägt der Erstversand komplett fehl, bleibt settlement_mail_sent_at
// NULL, obwohl settlement_announced_at gesetzt ist — resendSettlement muss
// in genau diesem Fall einen erneuten Versuch erlauben, auch OHNE
// changes_pending_since (sonst gäbe es aus diesem Zustand keinen Ausweg und
// die Crew würde nie erfahren, dass abgerechnet wurde).
describe("resendSettlement — Gate vs. tatsächliche Zustellung (Fund 2)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireMember.mockReset();
    mockedAdminClient.mockReset();
    mockedSendMails.mockReset();
    mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew" } as never);
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
  });

  it("erlaubt einen erneuten Versuch, wenn settlement_announced_at gesetzt ist, aber settlement_mail_sent_at NIE (kompletter Erstversand-Fehlschlag) — auch ohne changes_pending_since", async () => {
    const tripRow: Record<string, unknown> = {
      id: TRIP_ID,
      name: "Test-Törn",
      start_date: "2026-06-01",
      end_date: "2026-06-10",
      settlement_announced_at: "2026-06-11T10:00:00Z",
      settlement_mail_sent_at: null, // ← der Erstversand ist NIE angekommen
      changes_pending_since: null,
      last_settlement_resend_at: null,
      trip_type: "sailing",
    };

    let updatePayloadSeen: Record<string, unknown> | null = null;
    mockedAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "trips") {
          const b: Record<string, unknown> = {};
          const self = () => b;
          b.select = self;
          b.eq = self;
          b.maybeSingle = () => Promise.resolve({ data: tripRow });
          b.update = (payload: Record<string, unknown>) => {
            updatePayloadSeen = payload;
            return { eq: () => Promise.resolve({ error: null }) };
          };
          return b;
        }
        if (table === "trip_members") {
          return {
            select: () => ({ eq: () => Promise.resolve({ data: [] }) }),
          };
        }
        if (table === "persons_private") {
          return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) };
        }
        if (table === "audit_log") {
          return {
            select: () => ({
              eq: () => ({ in: () => ({ gte: () => Promise.resolve({ data: [] }) }) }),
            }),
          };
        }
        return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) };
      },
    } as never);
    mockedSendMails.mockResolvedValue([]);

    const res = await resendSettlement(TRIP_ID);

    // Kein Member in der Crew (leere Liste) → 0 Jobs, aber die Funktion muss
    // trotzdem am "nichts geändert"-Guard VORBEIKOMMEN — genau das ist der
    // entscheidende Beweis (sonst würde sie schon vorher mit ok:false und
    // der "nichts geändert"-Meldung abbrechen).
    expect(res.ok).toBe(true);
    // Ohne Crew-Mitglieder gibt es 0 zugestellte Mails (sent=0) → das
    // Update mit last_settlement_resend_at/settlement_mail_sent_at darf gar
    // nicht erst laufen (siehe `if (sent > 0)`-Guard in resendSettlement).
    expect(updatePayloadSeen).toBeNull();
  });
});
