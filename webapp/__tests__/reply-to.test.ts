// Reply-To = Skipper-/Reiseleitungs-Adresse: auslösende Person, wenn sie Leitung ist, sonst der Original-Skipper.
import { describe, expect, it, vi } from "vitest";
import { resolveReplyTo } from "@/lib/email/reply-to";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TRIP = "aaaaaaaa-0000-4000-8000-0000000000ff";
const SKIPPER = "aaaaaaaa-0000-4000-8000-000000000002";
const CO = "aaaaaaaa-0000-4000-8000-000000000003";
const CREW = "aaaaaaaa-0000-4000-8000-000000000004";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000005";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000006";

const EMAIL: Record<string, string> = {
  [SKIPPER]: "skipper@example.com",
  [CO]: "co@example.com",
  [CREW]: "crew@example.com",
  [ADMIN]: "admin@example.com",
  [OUTSIDER]: "outsider@example.com",
};

function fake(over: Record<string, Row[]> = {}) {
  return createFakeSupabase({
    trips: [{ id: TRIP, skipper_id: SKIPPER }],
    trip_members: [
      { trip_id: TRIP, person_id: SKIPPER, is_skipper: false },
      { trip_id: TRIP, person_id: CO, is_skipper: true },
      { trip_id: TRIP, person_id: CREW, is_skipper: false },
      // CREW ist in einem ANDEREN Törn Co-Skipper — darf hier nicht zählen.
      { trip_id: OTHER_TRIP, person_id: CREW, is_skipper: true },
      // OUTSIDER ist NUR in einem anderen Törn Co-Skipper, hier gar nicht Mitglied.
      { trip_id: OTHER_TRIP, person_id: OUTSIDER, is_skipper: true },
    ],
    persons_private: Object.entries(EMAIL).map(([person_id, email]) => ({ person_id, email })),
    ...over,
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (f: ReturnType<typeof fake>, actor?: string | null) => resolveReplyTo(f.client as any, TRIP, actor);

describe("resolveReplyTo", () => {
  it("Original-Skipper löst aus → seine Adresse", async () => {
    expect(await run(fake(), SKIPPER)).toBe(EMAIL[SKIPPER]);
  });
  it("Co-Skipper löst aus → SEINE Adresse (nicht die des Original-Skippers)", async () => {
    expect(await run(fake(), CO)).toBe(EMAIL[CO]);
  });
  it("Crewmitglied löst aus → Adresse des Original-Skippers, nie die der Crew", async () => {
    expect(await run(fake(), CREW)).toBe(EMAIL[SKIPPER]);
  });
  it("Co-Skipper eines ANDEREN Törns zählt hier nicht (Filter auf trip_id)", async () => {
    expect(await run(fake(), CREW)).not.toBe(EMAIL[CREW]);
  });
  it("Co-Skipper NUR eines anderen Törns (hier kein Mitglied) → Original-Skipper", async () => {
    expect(await run(fake(), OUTSIDER)).toBe(EMAIL[SKIPPER]);
  });
  it("Admin ohne Törnrolle → Original-Skipper", async () => {
    expect(await run(fake(), ADMIN)).toBe(EMAIL[SKIPPER]);
  });
  it("Cron / kein Auslöser → Original-Skipper", async () => {
    expect(await run(fake())).toBe(EMAIL[SKIPPER]);
    expect(await run(fake(), null)).toBe(EMAIL[SKIPPER]);
  });
  it("Leitung ohne hinterlegte Adresse → undefined (Fallback MAIL_REPLY_TO greift in send.ts)", async () => {
    const f = fake({ persons_private: [{ person_id: CREW, email: "crew@example.com" }] });
    expect(await run(f, CO)).toBeUndefined();
    expect(await run(f)).toBeUndefined();
  });
  it("Leere/Whitespace-Adresse zählt als fehlend, Adresse wird getrimmt", async () => {
    expect(await run(fake({ persons_private: [{ person_id: SKIPPER, email: "   " }] }))).toBeUndefined();
    expect(await run(fake({ persons_private: [{ person_id: SKIPPER, email: " s@example.com " }] }))).toBe("s@example.com");
  });
  it("Törn unbekannt → undefined", async () => {
    expect(await run(fake({ trips: [] }), SKIPPER)).toBeUndefined();
  });
  it("Lesefehler beim Mitgliedscheck → bleibt beim Original-Skipper, veröffentlicht nie die Auslöser-Adresse", async () => {
    const f = fake();
    f.failOn({ table: "trip_members", action: "select" });
    expect(await run(f, CO)).toBe(EMAIL[SKIPPER]);
  });
  it("Lesefehler bei den Adressen → undefined statt Wurf", async () => {
    const f = fake();
    f.failOn({ table: "persons_private", action: "select" });
    await expect(run(f, SKIPPER)).resolves.toBeUndefined();
  });
  it("Lesefehler bei trips → undefined", async () => {
    const f = fake();
    f.failOn({ table: "trips", action: "select" });
    expect(await run(f, SKIPPER)).toBeUndefined();
  });
  it("wirft nie, auch wenn der Client selbst wirft", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = { from: () => { throw new Error("boom"); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(resolveReplyTo(boom as any, TRIP, SKIPPER)).resolves.toBeUndefined();
  });
});
