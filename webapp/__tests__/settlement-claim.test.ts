// Slice 9 (Sicherheitsrunde 2026-11): announceSettlement/resendSettlement
// setzten ihre Marker erst NACH dem Versand — ein Doppelklick (zwei parallele
// Requests) verschickte alle Mails zweimal. Jetzt gewinnt ein atomarer Claim
// (`UPDATE … WHERE … RETURNING`) vor dem Versand. Zugleich muss ein komplett
// fehlgeschlagener Versand weiterhin wiederholbar bleiben (Fund 2, PR 6 /
// Migration 0052).
//
// Läuft gegen den filternden In-Memory-Fake: zwei per Promise.all gestartete
// Aufrufe lesen beide den alten Zustand, bevor einer claimt — genau das
// Doppelklick-Szenario.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./helpers/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ requireMember: vi.fn(), requireSkipperOrAdmin: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendMails: vi.fn() }));
vi.mock("@/lib/queries/balances", () => ({
  getBalances: vi.fn(),
  getBordkasseOnlyBalances: vi.fn(),
  getSimplifiedDebts: vi.fn(),
}));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));

import { announceSettlement, resendSettlement } from "@/lib/actions/settlement";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMails } from "@/lib/email/send";
import { getBalances, getBordkasseOnlyBalances, getSimplifiedDebts } from "@/lib/queries/balances";
import { sendPushToPersons } from "@/lib/notify/web-push";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const SKIPPER = "aaaaaaaa-0000-4000-8000-000000000002";
const CREW = "aaaaaaaa-0000-4000-8000-000000000003";
const ANNOUNCED = "2026-06-11T10:00:00.000Z";
const PENDING = "2026-06-12T09:00:00.000Z";

const mockedSend = vi.mocked(sendMails);

function setup(trip: {
  settlement_announced_at?: string | null;
  settlement_mail_sent_at?: string | null;
  changes_pending_since?: string | null;
}) {
  const fake = createFakeSupabase({
    trips: [
      {
        id: TRIP,
        name: "Test-Törn",
        start_date: "2026-06-01",
        end_date: "2026-06-10",
        trip_type: "sailing",
        settlement_announced_at: trip.settlement_announced_at ?? null,
        settlement_announced_by: null,
        settlement_mail_sent_at: trip.settlement_mail_sent_at ?? null,
        changes_pending_since: trip.changes_pending_since ?? null,
        last_settlement_resend_at: null,
      },
    ],
    trip_members: [
      { id: "m1", trip_id: TRIP, person_id: SKIPPER },
      { id: "m2", trip_id: TRIP, person_id: CREW },
    ],
    persons_private: [
      { person_id: SKIPPER, email: "skipper@example.test" },
      { person_id: CREW, email: "crew@example.test" },
    ],
    audit_log: [],
  });
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
  return fake;
}

const tripRow = (fake: ReturnType<typeof createFakeSupabase>) => fake.rows("trips")[0];
const mailsSent = () => mockedSend.mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentPerson).mockResolvedValue({ id: SKIPPER, display_name: "Skipper" } as never);
  vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: SKIPPER } as never);
  vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: SKIPPER } as never);
  const balances = [
    { person_id: SKIPPER, balance: 10 },
    { person_id: CREW, balance: -10 },
  ];
  vi.mocked(getBalances).mockResolvedValue(balances as never);
  vi.mocked(getBordkasseOnlyBalances).mockResolvedValue(balances as never);
  vi.mocked(getSimplifiedDebts).mockResolvedValue([] as never);
  mockedSend.mockImplementation(async (msgs) => msgs.map(() => ({ ok: true })) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

const ELEVEN_MIN = 11 * 60 * 1000;

describe("announceSettlement — atomarer Claim", () => {
  it("zwei parallele Aufrufe verschicken die Abrechnung nur EINMAL", async () => {
    const fake = setup({});
    const [a, b] = await Promise.all([announceSettlement(TRIP), announceSettlement(TRIP)]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mailsSent()).toBe(2);
    expect(tripRow(fake).settlement_announced_at).not.toBeNull();
    expect(tripRow(fake).settlement_mail_sent_at).not.toBeNull();
  });

  it("kompletter Versandfehlschlag: Gate bleibt, settlement_mail_sent_at wird zurückgesetzt → Retry über resendSettlement möglich", async () => {
    const fake = setup({});
    mockedSend.mockImplementationOnce(async (msgs) => msgs.map(() => ({ ok: false, error: "smtp" })) as never);

    const res = await announceSettlement(TRIP);
    expect(res.ok).toBe(true);
    expect(tripRow(fake).settlement_announced_at).not.toBeNull();
    expect(tripRow(fake).settlement_mail_sent_at).toBeNull();

    // Retry (Erstversand) klappt jetzt — ohne changes_pending_since.
    const retry = await resendSettlement(TRIP);
    expect(retry.ok).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(tripRow(fake).settlement_mail_sent_at).not.toBeNull();
  });

  it("kein Push „Abrechnung verschickt“, wenn keine Mail ankam", async () => {
    setup({});
    mockedSend.mockImplementationOnce(async (msgs) => msgs.map(() => ({ ok: false, error: "smtp" })) as never);
    await announceSettlement(TRIP);
    expect(vi.mocked(sendPushToPersons)).not.toHaveBeenCalled();
  });

  it("Lesefehler NACH dem Claim gibt den Claim vollständig zurück", async () => {
    const fake = setup({});
    vi.mocked(getBalances).mockRejectedValueOnce(new Error("db down"));
    const res = await announceSettlement(TRIP);
    expect(res.ok).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(tripRow(fake).settlement_announced_at).toBeNull();
    expect(tripRow(fake).settlement_announced_by).toBeNull();
  });

  it("Abbruch zwischen Claim und Versand sperrt nicht dauerhaft: Retry nach Ablauf der Versand-Sperre", async () => {
    const fake = setup({});
    mockedSend.mockImplementationOnce(async () => {
      throw new Error("Container-Neustart");
    });
    await expect(announceSettlement(TRIP)).rejects.toThrow();
    expect(tripRow(fake).settlement_announced_at).not.toBeNull();
    expect(tripRow(fake).settlement_mail_sent_at).toBeNull();

    // Sofort: gesperrt (es könnte ja noch ein Versand laufen).
    const early = await resendSettlement(TRIP);
    expect(early.ok).toBe(false);
    expect(mockedSend).toHaveBeenCalledTimes(1);

    // Nach Ablauf der Sperre: Erstversand wird nachgeholt.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ELEVEN_MIN);
    const later = await resendSettlement(TRIP);
    expect(later.ok).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(tripRow(fake).settlement_mail_sent_at).not.toBeNull();
  });

  it("verschickt nichts, wenn der Claim scheitert", async () => {
    const fake = setup({});
    fake.failOn({ table: "trips", action: "update" });
    const res = await announceSettlement(TRIP);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Abrechnungs-Flag");
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe("resendSettlement — atomarer Claim", () => {
  it("Update-Fall: zwei parallele Aufrufe verschicken die Update-Mail nur EINMAL", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: ANNOUNCED, changes_pending_since: PENDING });
    const [a, b] = await Promise.all([resendSettlement(TRIP), resendSettlement(TRIP)]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(tripRow(fake).changes_pending_since).toBeNull();
    expect(tripRow(fake).last_settlement_resend_at).not.toBeNull();
  });

  it("Erstversand-Retry: zwei parallele Aufrufe verschicken nur EINMAL", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null });
    const [a, b] = await Promise.all([resendSettlement(TRIP), resendSettlement(TRIP)]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(tripRow(fake).settlement_mail_sent_at).not.toBeNull();
  });

  it("Erstversand-Retry blockiert, solange ein announce gerade versendet (Gate frisch gesetzt)", async () => {
    setup({ settlement_announced_at: new Date().toISOString(), settlement_mail_sent_at: null });
    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("announce und Erstversand-Retry parallel verschicken nur EINMAL", async () => {
    // Komplett fehlgeschlagener Erstversand liegt lange zurück → Retry möglich;
    // gleichzeitig zweimal gedrückt.
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null });
    await Promise.all([resendSettlement(TRIP), resendSettlement(TRIP), announceSettlement(TRIP)]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // Gate wieder auf dem ursprünglichen Zeitpunkt.
    expect(tripRow(fake).settlement_announced_at).toBe(ANNOUNCED);
  });

  it("Update-Fall: Abbruch nach dem Claim — Marker/Banner bleiben, Retry nach Ablauf der Sperre", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: ANNOUNCED, changes_pending_since: PENDING });
    mockedSend.mockImplementationOnce(async () => {
      throw new Error("Container-Neustart");
    });
    await expect(resendSettlement(TRIP)).rejects.toThrow();
    expect(tripRow(fake).changes_pending_since).not.toBeNull();

    expect((await resendSettlement(TRIP)).ok).toBe(false);
    expect(mockedSend).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ELEVEN_MIN);
    expect((await resendSettlement(TRIP)).ok).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(tripRow(fake).changes_pending_since).toBeNull();
  });

  it("Erstversand-Retry erledigt einen schon offenen Änderungs-Marker mit", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null, changes_pending_since: PENDING });
    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(true);
    expect(tripRow(fake).changes_pending_since).toBeNull();
    expect(tripRow(fake).settlement_announced_at).toBe(ANNOUNCED);
  });

  it("Update-Fall, kompletter Fehlschlag: Marker wird wiederhergestellt → erneut versuchbar", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: ANNOUNCED, changes_pending_since: PENDING });
    mockedSend.mockImplementationOnce(async (msgs) => msgs.map(() => ({ ok: false, error: "smtp" })) as never);

    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(true);
    expect(tripRow(fake).changes_pending_since).toBe(PENDING);
    expect(tripRow(fake).last_settlement_resend_at).toBeNull();

    const retry = await resendSettlement(TRIP);
    expect(retry.ok).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(tripRow(fake).changes_pending_since).toBeNull();
  });

  it("Erstversand-Retry, kompletter Fehlschlag: settlement_mail_sent_at bleibt NULL", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null });
    mockedSend.mockImplementationOnce(async (msgs) => msgs.map(() => ({ ok: false, error: "smtp" })) as never);
    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(true);
    expect(tripRow(fake).settlement_mail_sent_at).toBeNull();
    // Claim zurückgegeben: Gate wieder auf dem ursprünglichen Zeitpunkt,
    // ein sofortiger erneuter Versuch klappt.
    expect(tripRow(fake).settlement_announced_at).toBe(ANNOUNCED);
    expect((await resendSettlement(TRIP)).ok).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(2);
  });

  it("Erstversand-Retry mit veraltetem Lesestand: ist inzwischen zugestellt, wird nichts mehr verschickt", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null });
    // 2. Zugriff auf trips = der Claim; kurz davor hat ein anderer Request
    // den Erstversand erfolgreich abgeschlossen (Gate zurück auf alt).
    fake.onFrom("trips", 2, () => {
      tripRow(fake).settlement_mail_sent_at = "2026-06-11T10:05:00.000Z";
    });
    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("ohne Crew-Postfach (0 Mails) bleibt der Erstversand wiederholbar", async () => {
    const fake = setup({ settlement_announced_at: ANNOUNCED, settlement_mail_sent_at: null });
    fake.rows("persons_private").splice(0);
    const res = await resendSettlement(TRIP);
    expect(res.ok).toBe(true);
    expect(tripRow(fake).settlement_mail_sent_at).toBeNull();
  });
});
