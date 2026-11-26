// Slice 3 (Sicherheitsrunde 2026-11): updateMember darf Name/E-Mail einer
// Ghost-Person, die auch Crew eines ANDEREN Törns ist, nur ändern, wenn der
// Ausführende Admin, die Person selbst oder in JEDEM ihrer Törns Skipper ist.
// Läuft gegen den filternden In-Memory-Fake: ein entfernter `.eq`/`.in`-Filter
// im Produktivcode ändert die Treffer und lässt einen Test rot werden.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ requireSkipperOrAdmin: vi.fn(), isAdmin: vi.fn() }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => undefined) }));

import { updateMember } from "@/lib/actions/trip-members";
import { isAdmin, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const TRIP_X = "aaaaaaaa-0000-4000-8000-000000000001";
const TRIP_Y = "aaaaaaaa-0000-4000-8000-000000000011";
const TRIP_Z = "aaaaaaaa-0000-4000-8000-000000000012";
const TRIP_W = "aaaaaaaa-0000-4000-8000-000000000013"; // Törn ohne Bezug zum Ghost
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000003"; // fremder Skipper
const GHOST = "aaaaaaaa-0000-4000-8000-000000000005";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const ANON = "Ehemaliges Crew-Mitglied";

type Scenario = {
  ghostName?: string;
  priorEmail?: string | null;
  /** Törns, in denen der Ghost Crew ist (trip_members-Zeile), jeweils mit Inhaber. */
  otherTrips?: Array<{ id: string; skipper: string }>;
  /** Zusätzliche trips-Zeilen (Inhaber), die keine Ghost-Mitgliedschaft haben. */
  extraTrips?: Array<{ id: string; skipper: string }>;
  /** trip_members-Zeilen des Ausführenden (oder anderer) als Skipper-Flag. */
  memberships?: Array<{ trip_id: string; person_id: string; is_skipper: boolean }>;
};

function setup(sc: Scenario) {
  const trips: Row[] = [{ id: TRIP_X, archived: false, skipper_id: ACTOR }];
  const members: Row[] = [
    {
      id: MEMBER_ID,
      trip_id: TRIP_X,
      person_id: GHOST,
      persons: { auth_user_id: null, display_name: sc.ghostName ?? "Ghost" },
    },
  ];
  for (const t of [...(sc.otherTrips ?? []), ...(sc.extraTrips ?? [])]) {
    trips.push({ id: t.id, archived: false, skipper_id: t.skipper });
  }
  for (const t of sc.otherTrips ?? []) {
    members.push({ id: `m-${t.id}`, trip_id: t.id, person_id: GHOST, is_skipper: false });
  }
  for (const m of sc.memberships ?? []) members.push({ id: `s-${m.trip_id}-${m.person_id}`, ...m });
  const fake = createFakeSupabase({
    trips,
    trip_members: members,
    persons_private: sc.priorEmail ? [{ person_id: GHOST, email: sc.priorEmail }] : [],
  });
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
  return fake;
}

function fd(over: Record<string, string>) {
  const d = new FormData();
  d.set("member_id", MEMBER_ID);
  d.set("trip_id", TRIP_X);
  for (const [k, v] of Object.entries(over)) d.set(k, v);
  return d;
}

const dataWrites = (fake: ReturnType<typeof createFakeSupabase>) =>
  fake.writes.filter((w) => w.table !== "audit_log");

async function run(sc: Scenario, form: Record<string, string>, admin = false) {
  const fake = setup(sc);
  vi.mocked(isAdmin).mockResolvedValue(admin);
  const res = await updateMember({ status: "idle" }, fd(form));
  return { res, fake, writes: dataWrites(fake) };
}

describe("updateMember — Name/E-Mail geteilter Personen (Slice 3)", () => {
  beforeEach(() => {
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: ACTOR });
  });

  it("fremder Skipper + neue E-Mail → abgelehnt, kein Write", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "neu@example.de", display_name: "Ghost" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("fremder Skipper + erste E-Mail für Ghost ohne Adresse → abgelehnt, kein Write", async () => {
    const { res, writes } = await run(
      { priorEmail: null, otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "neu@example.de", display_name: "Ghost" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("fremder Skipper + neuer Name → abgelehnt, kein Write, keine fremden Namen in der Meldung", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "alt@example.de", display_name: "Anderer Name" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
    if (res.status === "error") expect(res.message).not.toContain("Ghost");
  });

  it("Skipper nur eines von zwei fremden Törns → abgelehnt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [
          { id: TRIP_Y, skipper: ACTOR },
          { id: TRIP_Z, skipper: OTHER },
        ],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("Akteur ist Inhaber eines ANDEREN Törns (nicht von Y) → abgelehnt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [{ id: TRIP_Y, skipper: OTHER }],
        extraTrips: [{ id: TRIP_W, skipper: ACTOR }],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("Akteur ist Co-Skipper eines ANDEREN Törns (nicht von Y) → abgelehnt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [{ id: TRIP_Y, skipper: OTHER }],
        memberships: [{ trip_id: TRIP_W, person_id: ACTOR, is_skipper: true }],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("Akteur ist in Y nur gewöhnliches Mitglied (kein Skipper) → abgelehnt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [{ id: TRIP_Y, skipper: OTHER }],
        memberships: [{ trip_id: TRIP_Y, person_id: ACTOR, is_skipper: false }],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("eine ANDERE Person ist Co-Skipper in Y → abgelehnt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [{ id: TRIP_Y, skipper: OTHER }],
        memberships: [{ trip_id: TRIP_Y, person_id: OTHER, is_skipper: true }],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("Ghost steht nur als trips.skipper_id eines anderen Törns (ohne trip_members-Zeile) → abgelehnt", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", extraTrips: [{ id: TRIP_Y, skipper: GHOST }] },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("unveränderte Werte + neue Anwesenheit → erlaubt, Name/E-Mail nicht neu geschrieben", async () => {
    const { res, writes } = await run(
      { ghostName: "Ghost", priorEmail: "Alt@Example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "alt@example.de", display_name: "Ghost", on_board_from: "2026-05-01" },
    );
    expect(res.status).toBe("ok");
    expect(writes.map((w) => w.table)).toEqual(["trip_members"]);
  });

  it("nur eigene Törns (Inhaber bzw. Co-Skipper) → erlaubt", async () => {
    const { res, writes } = await run(
      {
        priorEmail: "alt@example.de",
        otherTrips: [
          { id: TRIP_Y, skipper: ACTOR },
          { id: TRIP_Z, skipper: OTHER },
        ],
        memberships: [{ trip_id: TRIP_Z, person_id: ACTOR, is_skipper: true }],
      },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("ok");
    expect(writes.some((w) => w.table === "persons_private" && w.action === "upsert")).toBe(true);
  });

  it("Ghost nur in diesem Törn → erlaubt", async () => {
    const { res } = await run({ priorEmail: "alt@example.de" }, { email: "neu@example.de" });
    expect(res.status).toBe("ok");
  });

  it("globaler Admin → erlaubt", async () => {
    const { res } = await run(
      { priorEmail: "alt@example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "neu@example.de" },
      true,
    );
    expect(res.status).toBe("ok");
  });

  it("die Person selbst → erlaubt", async () => {
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: GHOST });
    const { res } = await run(
      { priorEmail: "alt@example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("ok");
  });

  it("anonymisierte Person (Kontolöschung) → Name/E-Mail gesperrt, auch für Admin", async () => {
    for (const admin of [false, true]) {
      const { res, writes } = await run({ ghostName: ANON }, { email: "neu@example.de" }, admin);
      expect(res.status).toBe("error");
      expect(writes).toEqual([]);
    }
  });

  it("anonymisierte Person: Anwesenheit ohne Name/E-Mail-Änderung bleibt möglich", async () => {
    const { res } = await run({ ghostName: ANON }, { on_board_from: "2026-05-01" });
    expect(res.status).toBe("ok");
  });

  // Lesefehler: n-te select-Operation je Tabelle scheitert → fail-closed.
  const reads: Array<[string, string, number]> = [
    ["bisherige E-Mail", "persons_private", 1],
    ["andere Törns (trip_members)", "trip_members", 2],
    ["eigene Törns der Person (trips)", "trips", 2],
    ["Inhaber-Abfrage (trips)", "trips", 3],
    ["Co-Skipper-Abfrage (trip_members)", "trip_members", 3],
  ];
  it.each(reads)("Lesefehler (%s) → abgelehnt, kein Write", async (_n, table, nth) => {
    const fake = setup({ priorEmail: "alt@example.de", otherTrips: [{ id: TRIP_Y, skipper: OTHER }] });
    fake.failOn({ table, action: "select", nth });
    vi.mocked(isAdmin).mockResolvedValue(false);
    const res = await updateMember({ status: "idle" }, fd({ email: "neu@example.de" }));
    expect(res.status).toBe("error");
    expect(dataWrites(fake)).toEqual([]);
  });

  it("Lesefehler bei der bisherigen E-Mail → abgelehnt, auch wenn der Ghost sonst nirgends Crew ist", async () => {
    const fake = setup({ priorEmail: "alt@example.de" });
    fake.failOn({ table: "persons_private", action: "select", nth: 1 });
    vi.mocked(isAdmin).mockResolvedValue(false);
    const res = await updateMember({ status: "idle" }, fd({ email: "neu@example.de" }));
    expect(res.status).toBe("error");
    expect(dataWrites(fake)).toEqual([]);
  });
});
