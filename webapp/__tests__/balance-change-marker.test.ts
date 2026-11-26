// Slice 9 (Sicherheitsrunde 2026-11): Pfade, die Salden NACH der Abrechnung
// verschieben, müssen den „Bilanz hat sich geändert"-Marker setzen
// (`mark_post_settlement_change` → trips.changes_pending_since) — sonst sieht
// niemand den Banner und abgehakte Schulden werden still entwertet.
// Außerdem: das Profil-Flag `is_alcoholic` wirkt nur noch als Vorbelegung.
//
// Läuft gegen den filternden In-Memory-Fake; die RPC bildet die echte
// SQL-Semantik aus 0019 nach (nur nach der Abrechnung, nur einmal).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireTripOwnerOrAdmin: vi.fn(),
  requireAdmin: vi.fn(),
  requireAdminOrTripCreator: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/auth/origin", () => ({ resolveOrigin: vi.fn(() => "http://localhost:3000") }));

import { updateTripDates } from "@/lib/actions/trips";
import { inviteMember, removeMember, updateMember } from "@/lib/actions/trip-members";
import { updateProfile } from "@/app/profile/actions";
import { selectMembershipsToPin } from "@/lib/db/alcohol-pin";
import { requireSkipperOrAdmin, isAdmin } from "@/lib/auth/authz";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayIso } from "@/lib/utils";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const PERSON = "aaaaaaaa-0000-4000-8000-000000000003";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000004";
const ANNOUNCED = "2026-06-11T10:00:00.000Z";

type Fake = ReturnType<typeof createFakeSupabase>;

function setup(opts: { announced?: boolean; archived?: boolean; extra?: Record<string, Row[]> } = {}): Fake {
  const fake = createFakeSupabase({
    trips: [
      {
        id: TRIP,
        archived: opts.archived ?? false,
        skipper_id: ACTOR,
        start_date: "2026-06-01",
        end_date: "2026-06-10",
        settlement_announced_at: opts.announced === false ? null : ANNOUNCED,
        changes_pending_since: null,
      },
    ],
    trip_members: [
      { id: "m-actor", trip_id: TRIP, person_id: ACTOR, is_skipper: true, on_board_from: null, on_board_to: null, is_alcoholic: null },
      {
        id: MEMBER,
        trip_id: TRIP,
        person_id: PERSON,
        is_skipper: false,
        on_board_from: null,
        on_board_to: null,
        is_alcoholic: null,
        note: null,
        persons: { auth_user_id: "auth-1", display_name: "Crew" },
      },
    ],
    ...(opts.extra ?? {}),
  });
  // Echte SQL-Semantik aus 0019: nur nach der Abrechnung, nur einmal.
  fake.onRpc("mark_post_settlement_change", (args) => {
    const t = fake.rows("trips").find((r) => r.id === args.p_trip_id);
    if (t && t.settlement_announced_at && !t.changes_pending_since) t.changes_pending_since = "marked";
    return { data: null };
  });
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
  return fake;
}

const marked = (fake: Fake) => fake.rows("trips").find((r) => r.id === TRIP)?.changes_pending_since === "marked";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: ACTOR } as never);
  vi.mocked(isAdmin).mockResolvedValue(false);
});

describe("updateTripDates — Marker + Archiv-Guard", () => {
  const form = () => fd({ trip_id: TRIP, start_date: "2026-06-02", end_date: "2026-06-10" });

  it("setzt nach der Abrechnung den Marker", async () => {
    const fake = setup();
    const res = await updateTripDates({ status: "idle" } as never, form());
    expect(res.status).toBe("ok");
    expect(marked(fake)).toBe(true);
  });

  it("setzt keinen Marker, wenn das Speichern scheitert", async () => {
    const fake = setup();
    fake.failOn({ table: "trips", action: "update" });
    const res = await updateTripDates({ status: "idle" } as never, form());
    expect(res.status).toBe("error");
    expect(marked(fake)).toBe(false);
  });

  it("lehnt einen archivierten Törn ab und ändert nichts", async () => {
    const fake = setup({ archived: true });
    const res = await updateTripDates({ status: "idle" } as never, form());
    expect(res.status).toBe("error");
    expect(fake.rows("trips")[0].start_date).toBe("2026-06-01");
    expect(marked(fake)).toBe(false);
  });
});

describe("inviteMember — neues Mitglied verdünnt rückwirkend", () => {
  const form = () => fd({ trip_id: TRIP, email: "", display_name: "Nachzügler", is_alcoholic: "" });

  it("setzt nach der Abrechnung den Marker", async () => {
    const fake = setup();
    const res = await inviteMember({ status: "idle" }, form());
    expect(res.status).toBe("ok");
    expect(fake.rows("trip_members")).toHaveLength(3);
    expect(marked(fake)).toBe(true);
  });

  it("setzt keinen Marker, wenn die Mitgliedschaft nicht angelegt wird", async () => {
    const fake = setup();
    fake.failOn({ table: "trip_members", action: "upsert" });
    const res = await inviteMember({ status: "idle" }, form());
    expect(res.status).toBe("error");
    expect(marked(fake)).toBe(false);
  });

  it("ist vor der Abrechnung wirkungslos (kein Banner ohne Abrechnung)", async () => {
    const fake = setup({ announced: false });
    await inviteMember({ status: "idle" }, form());
    expect(fake.rows("trips")[0].changes_pending_since).toBeNull();
  });
});

describe("removeMember — Mitglied fällt aus den Anteilen", () => {
  it("setzt nach der Abrechnung den Marker", async () => {
    const fake = setup();
    const res = await removeMember(MEMBER, TRIP);
    expect(res.ok).toBe(true);
    expect(fake.rows("trip_members").some((m) => m.id === MEMBER)).toBe(false);
    expect(marked(fake)).toBe(true);
  });

  it("setzt keinen Marker, wenn das Entfernen scheitert", async () => {
    const fake = setup();
    fake.failOn({ table: "trip_members", action: "delete" });
    const res = await removeMember(MEMBER, TRIP);
    expect(res.ok).toBe(false);
    expect(marked(fake)).toBe(false);
  });
});

describe("updateMember — Anwesenheit / Trinker-Flag", () => {
  const form = (over: Record<string, string> = {}) =>
    fd({ member_id: MEMBER, trip_id: TRIP, on_board_from: "", on_board_to: "", is_alcoholic: "", note: "", ...over });

  it("setzt bei geänderter Anwesenheit den Marker", async () => {
    const fake = setup();
    const res = await updateMember({ status: "idle" }, form({ on_board_from: "2026-06-04" }));
    expect(res.status).toBe("ok");
    expect(marked(fake)).toBe(true);
  });

  it("setzt bei geändertem Trinker-Flag den Marker", async () => {
    const fake = setup();
    const res = await updateMember({ status: "idle" }, form({ is_alcoholic: "no" }));
    expect(res.status).toBe("ok");
    expect(marked(fake)).toBe(true);
  });

  it("setzt bei reiner Notiz-Änderung KEINEN Marker", async () => {
    const fake = setup();
    const res = await updateMember({ status: "idle" }, form({ note: "Kojen-Wunsch" }));
    expect(res.status).toBe("ok");
    expect(marked(fake)).toBe(false);
  });

  it("setzt keinen Marker, wenn das Speichern scheitert", async () => {
    const fake = setup();
    fake.failOn({ table: "trip_members", action: "update" });
    const res = await updateMember({ status: "idle" }, form({ is_alcoholic: "no" }));
    expect(res.status).toBe("error");
    expect(marked(fake)).toBe(false);
  });
});

describe("updateMember — Ghost-Merge", () => {
  const GHOST = "aaaaaaaa-0000-4000-8000-000000000021";
  const REAL = "aaaaaaaa-0000-4000-8000-000000000022";
  const GHOST_MEMBER = "aaaaaaaa-0000-4000-8000-000000000023";

  function mergeSetup(): Fake {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, archived: false, skipper_id: ACTOR, settlement_announced_at: ANNOUNCED, changes_pending_since: null }],
      trip_members: [
        {
          id: GHOST_MEMBER,
          trip_id: TRIP,
          person_id: GHOST,
          on_board_from: null,
          on_board_to: null,
          is_alcoholic: null,
          note: null,
          persons: { auth_user_id: null, display_name: "Ghost" },
        },
      ],
      persons: [
        { id: GHOST, display_name: "Ghost", is_alcoholic: true, auth_user_id: null },
        { id: REAL, display_name: "Real", is_alcoholic: false, auth_user_id: null },
      ],
      persons_private: [
        { person_id: REAL, email: "real@example.test", persons: { display_name: "Real", auth_user_id: null } },
      ],
    });
    fake.onRpc("mark_post_settlement_change", (args) => {
      const t = fake.rows("trips").find((r) => r.id === args.p_trip_id);
      if (t && t.settlement_announced_at && !t.changes_pending_since) t.changes_pending_since = "marked";
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    return fake;
  }

  const mergeForm = () =>
    fd({
      member_id: GHOST_MEMBER,
      trip_id: TRIP,
      display_name: "",
      email: "real@example.test",
      on_board_from: "",
      on_board_to: "",
      is_alcoholic: "",
      note: "",
    });

  it("schreibt das Trinker-Flag des Ghosts fest und setzt den Marker", async () => {
    const fake = mergeSetup();
    const res = await updateMember({ status: "idle" }, mergeForm());
    expect(res.status).toBe("ok");
    const tm = fake.rows("trip_members").find((m) => m.id === GHOST_MEMBER)!;
    expect(tm.person_id).toBe(REAL);
    // Ohne Festschreiben gälte jetzt das Flag der echten Person (false).
    expect(tm.is_alcoholic).toBe(true);
    expect(marked(fake)).toBe(true);
  });

  it("setzt den Marker auch, wenn der Merge mittendrin scheitert", async () => {
    const fake = mergeSetup();
    fake.failOn({ table: "transactions", action: "update", nth: 2 });
    const res = await updateMember({ status: "idle" }, mergeForm());
    expect(res.status).toBe("error");
    expect(marked(fake)).toBe(true);
  });
});

// ── Profil-Flag nur noch als Vorbelegung ───────────────────────────────────

const PAST = "aaaaaaaa-0000-4000-8000-000000000101"; // begonnen
const FUTURE_BOOKED = "aaaaaaaa-0000-4000-8000-000000000102"; // künftig, mit Buchung
const FUTURE_EMPTY = "aaaaaaaa-0000-4000-8000-000000000103"; // künftig, ohne Buchung
const FUTURE_DELETED = "aaaaaaaa-0000-4000-8000-000000000104"; // künftig, nur gelöschte Buchung
const EXPLICIT = "aaaaaaaa-0000-4000-8000-000000000105"; // begonnen, eigener Wert

function profileSetup(personAlcoholic: boolean): Fake {
  const fake = createFakeSupabase({
    persons: [{ id: PERSON, display_name: "Crew", is_alcoholic: personAlcoholic }],
    trips: [
      { id: PAST, start_date: "2020-06-01" },
      { id: FUTURE_BOOKED, start_date: "2999-06-01" },
      { id: FUTURE_EMPTY, start_date: "2999-07-01" },
      { id: FUTURE_DELETED, start_date: "2999-08-01" },
      { id: EXPLICIT, start_date: "2020-01-01" },
    ],
    trip_members: [
      { id: "tm-past", trip_id: PAST, person_id: PERSON, is_alcoholic: null },
      { id: "tm-booked", trip_id: FUTURE_BOOKED, person_id: PERSON, is_alcoholic: null },
      { id: "tm-empty", trip_id: FUTURE_EMPTY, person_id: PERSON, is_alcoholic: null },
      { id: "tm-deleted", trip_id: FUTURE_DELETED, person_id: PERSON, is_alcoholic: null },
      { id: "tm-explicit", trip_id: EXPLICIT, person_id: PERSON, is_alcoholic: false },
      // Andere Person im selben Törn — darf nie angefasst werden.
      { id: "tm-other", trip_id: PAST, person_id: ACTOR, is_alcoholic: null },
    ],
    transactions: [
      { id: "tx-1", trip_id: FUTURE_BOOKED, deleted_at: null },
      { id: "tx-2", trip_id: FUTURE_DELETED, deleted_at: "2026-01-01T00:00:00Z" },
    ],
  });
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
  vi.mocked(getCurrentPerson).mockResolvedValue({ id: PERSON } as never);
  return fake;
}

/**
 * Effektives Trinker-Flag je Törn wie in v_transaction_shares:
 * COALESCE(tm.is_alcoholic, p.is_alcoholic, FALSE) (0032, Zeile 44).
 */
function effective(fake: Fake, tripId: string): boolean {
  const tm = fake.rows("trip_members").find((m) => m.trip_id === tripId && m.person_id === PERSON)!;
  const p = fake.rows("persons").find((r) => r.id === PERSON)!;
  return (tm.is_alcoholic as boolean | null) ?? (p.is_alcoholic as boolean | null) ?? false;
}

const profileForm = (alcoholic: boolean) => {
  const f = fd({ display_name: "Crew" });
  if (alcoholic) f.set("is_alcoholic", "on");
  return f;
};

describe("updateProfile — Trinker-Flag wirkt nicht mehr rückwirkend", () => {
  it("„trinke nicht“ nach dem Törn ändert keinen Alkoholanteil in begonnenen/gebuchten Törns", async () => {
    const fake = profileSetup(true);
    const before = [PAST, FUTURE_BOOKED, EXPLICIT].map((t) => effective(fake, t));

    const res = await updateProfile({ status: "idle" }, profileForm(false));

    expect(res.status).toBe("ok");
    expect(fake.rows("persons")[0].is_alcoholic).toBe(false);
    // Saldo-relevante Eingabe unverändert → v_transaction_shares rechnet gleich.
    expect([PAST, FUTURE_BOOKED, EXPLICIT].map((t) => effective(fake, t))).toEqual(before);
    // Künftige Törns ohne (lebende) Buchung übernehmen die neue Vorbelegung.
    expect(effective(fake, FUTURE_EMPTY)).toBe(false);
    expect(effective(fake, FUTURE_DELETED)).toBe(false);
    expect(fake.rows("trip_members").find((m) => m.id === "tm-empty")!.is_alcoholic).toBeNull();
    // Fremde Mitgliedschaft und eigener Wert bleiben unberührt.
    expect(fake.rows("trip_members").find((m) => m.id === "tm-other")!.is_alcoholic).toBeNull();
    expect(fake.rows("trip_members").find((m) => m.id === "tm-explicit")!.is_alcoholic).toBe(false);
  });

  it("schreibt auch „trinkt nicht“ fest, wenn jemand nachträglich „trinke“ setzt", async () => {
    const fake = profileSetup(false);
    await updateProfile({ status: "idle" }, profileForm(true));
    expect(effective(fake, PAST)).toBe(false);
    expect(effective(fake, FUTURE_BOOKED)).toBe(false);
    expect(effective(fake, FUTURE_EMPTY)).toBe(true);
  });

  it("überschreibt keinen Wert, den der Skipper parallel gesetzt hat", async () => {
    const fake = profileSetup(true);
    // 2. Zugriff auf trip_members = das festschreibende UPDATE; unmittelbar
    // davor setzt „der Skipper" einen eigenen Wert.
    fake.onFrom("trip_members", 2, () => {
      fake.rows("trip_members").find((m) => m.id === "tm-past")!.is_alcoholic = false;
    });
    const res = await updateProfile({ status: "idle" }, profileForm(false));
    expect(res.status).toBe("ok");
    expect(fake.rows("trip_members").find((m) => m.id === "tm-past")!.is_alcoholic).toBe(false);
    expect(fake.rows("trip_members").find((m) => m.id === "tm-booked")!.is_alcoholic).toBe(true);
  });

  it("schreibt nichts fest, wenn sich das Flag nicht ändert (nur Name)", async () => {
    const fake = profileSetup(true);
    await updateProfile({ status: "idle" }, profileForm(true));
    expect(fake.rows("trip_members").find((m) => m.id === "tm-past")!.is_alcoholic).toBeNull();
    expect(fake.writes.some((w) => w.table === "trip_members")).toBe(false);
  });

  it.each([
    ["trip_members", "select"],
    ["trips", "select"],
    ["transactions", "select"],
    ["trip_members", "update"],
  ] as const)("bricht fail-closed ab, wenn %s.%s scheitert — Profil bleibt unverändert", async (table, action) => {
    const fake = profileSetup(true);
    fake.failOn({ table, action });
    const res = await updateProfile({ status: "idle" }, profileForm(false));
    expect(res.status).toBe("error");
    expect(fake.rows("persons")[0].is_alcoholic).toBe(true);
  });

  it("bricht ab, wenn das bisherige Profil nicht lesbar ist", async () => {
    const fake = profileSetup(true);
    fake.failOn({ table: "persons", action: "select" });
    const res = await updateProfile({ status: "idle" }, profileForm(false));
    expect(res.status).toBe("error");
    expect(fake.rows("persons")[0].is_alcoholic).toBe(true);
  });
});

describe("selectMembershipsToPin (reine Auswahl)", () => {
  const today = "2026-06-05";
  const cands = [
    { id: "a", trip_id: "t-started" },
    { id: "b", trip_id: "t-today" },
    { id: "c", trip_id: "t-future" },
    { id: "d", trip_id: "t-future-booked" },
    { id: "e", trip_id: "t-unknown" },
  ];
  const starts = new Map([
    ["t-started", "2026-06-01"],
    ["t-today", "2026-06-05"],
    ["t-future", "2026-07-01"],
    ["t-future-booked", "2026-07-01"],
  ]);

  it("wählt begonnene (inkl. heute), gebuchte und unbekannte Törns", () => {
    expect(selectMembershipsToPin(cands, starts, new Set(["t-future-booked"]), today)).toEqual(["a", "b", "d", "e"]);
  });

  it("todayIso liefert ein ISO-Datum (Vergleich als String)", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
