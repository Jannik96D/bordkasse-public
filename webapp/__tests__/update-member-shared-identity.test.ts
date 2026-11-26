// Slice 3 (Sicherheitsrunde 2026-11): updateMember darf Name/E-Mail einer
// Ghost-Person, die auch Crew eines ANDEREN Törns ist, nur ändern, wenn der
// Ausführende Admin, die Person selbst oder in JEDEM ihrer Törns Skipper ist.
// Der Mock bildet die Tabellen ab und protokolliert jeden Write.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const GHOST = "aaaaaaaa-0000-4000-8000-000000000005";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000004";

type Scenario = {
  ghostName?: string;
  priorEmail?: string | null;
  otherTrips?: string[]; // weitere Törns des Ghosts
  ownedTrips?: string[]; // trips.skipper_id = Ausführender
  coSkipperTrips?: string[]; // trip_members.is_skipper des Ausführenden
  failRead?: "others" | "prior" | "owned" | "co";
};

const FAIL = { data: null, error: { message: "boom" } };

function makeSupabase(sc: Scenario) {
  const writes: { table: string; method: string }[] = [];
  const make = (table: string) => {
    const hasFilter = new Set<string>();
    let method = "select";
    const b: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (..._args: unknown[]) => {
        if (name === "update" || name === "upsert" || name === "delete") {
          method = name;
          writes.push({ table, method: name });
        } else {
          hasFilter.add(name);
        }
        return b;
      };
    for (const n of ["select", "eq", "neq", "in", "is", "update", "upsert", "delete"]) b[n] = chain(n);
    b.insert = () => Promise.resolve({ error: null }); // logAudit

    const read = (single: boolean): unknown => {
      if (method !== "select") return { error: null };
      if (table === "trips") {
        if (single) return { data: { archived: false }, error: null };
        if (sc.failRead === "owned") return FAIL;
        return { data: (sc.ownedTrips ?? []).map((id) => ({ id })), error: null };
      }
      if (table === "persons_private") {
        if (hasFilter.has("neq")) return { data: null, error: null }; // E-Mail-Kollisionsprüfung: frei
        if (sc.failRead === "prior") return FAIL;
        return { data: sc.priorEmail ? { email: sc.priorEmail } : null, error: null };
      }
      if (table === "trip_members") {
        if (single) {
          return {
            data: { person_id: GHOST, persons: { auth_user_id: null, display_name: sc.ghostName ?? "Ghost" } },
            error: null,
          };
        }
        if (hasFilter.has("neq")) {
          if (sc.failRead === "others") return FAIL;
          return { data: (sc.otherTrips ?? []).map((trip_id) => ({ trip_id })), error: null };
        }
        if (sc.failRead === "co") return FAIL;
        return { data: (sc.coSkipperTrips ?? []).map((trip_id) => ({ trip_id })), error: null };
      }
      return { data: null, error: null };
    };
    b.maybeSingle = () => Promise.resolve(read(true));
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve(read(false)).then(ok);
    return b;
  };
  return { supabase: { from: make }, writes };
}

function fd(over: Record<string, string>) {
  const d = new FormData();
  d.set("member_id", MEMBER_ID);
  d.set("trip_id", TRIP_X);
  for (const [k, v] of Object.entries(over)) d.set(k, v);
  return d;
}

async function run(sc: Scenario, form: Record<string, string>, admin = false) {
  const { supabase, writes } = makeSupabase(sc);
  vi.mocked(createAdminClient).mockReturnValue(supabase as never);
  vi.mocked(isAdmin).mockResolvedValue(admin);
  const res = await updateMember({ status: "idle" }, fd(form));
  return { res, writes };
}

describe("updateMember — Name/E-Mail geteilter Personen (Slice 3)", () => {
  beforeEach(() => {
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: ACTOR });
  });

  it("fremder Skipper + neue E-Mail → abgelehnt, kein Write", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [TRIP_Y] },
      { email: "neu@example.de", display_name: "Ghost" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("fremder Skipper + erste E-Mail für Ghost ohne Adresse → abgelehnt, kein Write", async () => {
    const { res, writes } = await run(
      { priorEmail: null, otherTrips: [TRIP_Y] },
      { email: "neu@example.de", display_name: "Ghost" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("fremder Skipper + neuer Name → abgelehnt, kein Write, keine fremden Namen in der Meldung", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [TRIP_Y] },
      { email: "alt@example.de", display_name: "Anderer Name" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
    if (res.status === "error") expect(res.message).not.toContain("Ghost");
  });

  it("Skipper nur eines von zwei fremden Törns → abgelehnt", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [TRIP_Y, TRIP_Z], ownedTrips: [TRIP_Y] },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("unveränderte Werte + neue Anwesenheit → erlaubt, Name/E-Mail nicht neu geschrieben", async () => {
    const { res, writes } = await run(
      { ghostName: "Ghost", priorEmail: "Alt@Example.de", otherTrips: [TRIP_Y] },
      { email: "alt@example.de", display_name: "Ghost", on_board_from: "2026-05-01" },
    );
    expect(res.status).toBe("ok");
    expect(writes.map((w) => w.table)).toEqual(["trip_members"]);
  });

  it("nur eigene Törns (Inhaber bzw. Co-Skipper) → erlaubt", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [TRIP_Y, TRIP_Z], ownedTrips: [TRIP_Y], coSkipperTrips: [TRIP_Z] },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("ok");
    expect(writes.some((w) => w.table === "persons_private" && w.method === "upsert")).toBe(true);
  });

  it("Ghost nur in diesem Törn → erlaubt", async () => {
    const { res } = await run({ priorEmail: "alt@example.de", otherTrips: [] }, { email: "neu@example.de" });
    expect(res.status).toBe("ok");
  });

  it("globaler Admin → erlaubt", async () => {
    const { res } = await run({ priorEmail: "alt@example.de", otherTrips: [TRIP_Y] }, { email: "neu@example.de" }, true);
    expect(res.status).toBe("ok");
  });

  it("die Person selbst → erlaubt", async () => {
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: GHOST });
    const { res } = await run({ priorEmail: "alt@example.de", otherTrips: [TRIP_Y] }, { email: "neu@example.de" });
    expect(res.status).toBe("ok");
  });

  it.each(["others", "prior", "owned", "co"] as const)("Lesefehler (%s) → abgelehnt, kein Write", async (failRead) => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [TRIP_Y], failRead },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });

  it("Lesefehler bei der bisherigen E-Mail → abgelehnt, auch wenn der Ghost sonst nirgends Crew ist", async () => {
    const { res, writes } = await run(
      { priorEmail: "alt@example.de", otherTrips: [], failRead: "prior" },
      { email: "neu@example.de" },
    );
    expect(res.status).toBe("error");
    expect(writes).toEqual([]);
  });
});
