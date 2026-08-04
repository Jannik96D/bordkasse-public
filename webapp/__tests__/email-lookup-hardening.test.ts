// Regression zu Fund 9 (Code-Review 2026-08): mehrere E-Mail-Lookups nutzten
// `.ilike("email", x)` statt `.eq("email", x)`, obwohl die Spalte bereits
// CITEXT (case-insensitiv) ist — `ilike` brachte nur unbeabsichtigte
// Wildcards (`%`/`_`) ins Spiel. Am schwersten wog das beim Ghost-Linking in
// getCurrentPerson: ein `_` als Ein-Zeichen-Joker hätte einen frisch
// eingeloggten Auth-User mit einer E-Mail wie `max_mueller@…` mit der
// FREMDEN Ghost-Person `max.mueller@…` verlinken und deren Törn-
// Mitgliedschaften übernehmen lassen können. Diese Tests prüfen zwei Dinge:
// (1) die tatsächlichen Query-Builder-Aufrufe nutzen `.eq`, nicht `.ilike`;
// (2) ein DB-Fehler wird jetzt fail-closed behandelt statt still als
// "nicht gefunden" durchgereicht zu werden (was sonst zur Neuanlage einer
// zusätzlichen Person geführt hätte).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { isEmailAllowedToSignIn } from "@/lib/auth/authz";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const mockedAdminClient = vi.mocked(createAdminClient);
const mockedCookieClient = vi.mocked(createClient);

type Call = { table: string; method: string; args: unknown[] };

/** Erfasst jeden Query-Builder-Aufruf (Tabelle, Methode, Argumente). */
function makeSupabase(opts: {
  maybeSingleResponses: Record<string, unknown>; // table -> {data, error}
}) {
  const { maybeSingleResponses } = opts;
  const calls: Call[] = [];
  const insertCalls: { table: string; payload: unknown }[] = [];
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    b.select = record("select");
    b.eq = record("eq");
    b.ilike = record("ilike");
    b.is = record("is");
    b.insert = (payload: unknown) => {
      insertCalls.push({ table, payload });
      return b;
    };
    b.single = () => Promise.resolve({ data: null, error: null });
    b.maybeSingle = () => Promise.resolve(maybeSingleResponses[table] ?? { data: null, error: null });
    return b;
  };
  return { from: (table: string) => make(table), calls, insertCalls };
}

function hasCall(calls: Call[], table: string, method: string): boolean {
  return calls.some((c) => c.table === table && c.method === method);
}

describe("isEmailAllowedToSignIn — nutzt eq statt ilike (Fund 9)", () => {
  it("fragt persons_private mit .eq ab, nicht .ilike", async () => {
    const { supabase, calls } = (() => {
      const s = makeSupabase({
        maybeSingleResponses: { persons_private: { data: { person_id: "p1" }, error: null } },
      });
      return { supabase: s, calls: s.calls };
    })();
    mockedAdminClient.mockReturnValue(supabase as never);

    const allowed = await isEmailAllowedToSignIn("crew@example.de");

    expect(allowed).toBe(true);
    expect(hasCall(calls, "persons_private", "eq")).toBe(true);
    expect(hasCall(calls, "persons_private", "ilike")).toBe(false);
  });

  it("gibt bei einem DB-Fehler fail-closed false zurück", async () => {
    const s = makeSupabase({
      maybeSingleResponses: { persons_private: { data: null, error: { message: "connection reset" } } },
    });
    mockedAdminClient.mockReturnValue(s as never);

    const allowed = await isEmailAllowedToSignIn("crew@example.de");
    expect(allowed).toBe(false);
  });
});

describe("getCurrentPerson — Ghost-Linking nutzt eq statt ilike (Fund 9)", () => {
  const AUTH_UID = "11110000-0000-4000-8000-000000000001";
  const TARGET_EMAIL = "max_mueller@example.de";
  const GHOST_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000002";

  beforeEach(() => {
    mockedAdminClient.mockReset();
    mockedCookieClient.mockReset();
    mockedCookieClient.mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: AUTH_UID, email: TARGET_EMAIL } } }) },
    } as never);
  });

  it("fragt die Ghost-Person mit .eq ab, nicht .ilike", async () => {
    const s = makeSupabase({
      maybeSingleResponses: {
        // 1. persons.eq(auth_user_id) → noch nicht verlinkt
        persons: { data: null, error: null },
        // 2. persons_private-Ghost-Lookup → Treffer
        persons_private: { data: { person_id: GHOST_PERSON_ID, email: TARGET_EMAIL }, error: null },
      },
    });
    mockedAdminClient.mockReturnValue(s as never);

    await getCurrentPerson();

    expect(hasCall(s.calls, "persons_private", "eq")).toBe(true);
    expect(hasCall(s.calls, "persons_private", "ilike")).toBe(false);
  });

  it("legt bei einem DB-Fehler im Ghost-Lookup KEINE neue Person an (fail-closed statt Duplikat)", async () => {
    const s = makeSupabase({
      maybeSingleResponses: {
        persons: { data: null, error: null },
        persons_private: { data: null, error: { message: "connection reset" } },
      },
    });
    mockedAdminClient.mockReturnValue(s as never);

    const result = await getCurrentPerson();

    expect(result).toBeNull();
    // Der alte Code hätte hier in den "kein Ghost gefunden"-Zweig
    // durchgereicht und eine neue persons-Zeile angelegt.
    expect(s.insertCalls.some((c) => c.table === "persons")).toBe(false);
  });
});
