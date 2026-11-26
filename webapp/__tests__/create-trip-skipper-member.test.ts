// Slice 3: createTrip prüft den Insert der Skipper-Mitgliedschaft. Ohne diese
// Zeile fehlte der Törn in `mayChangeSharedIdentity` (Erkennung über
// trip_members) und der Skipper hätte keine Crew-Rolle — also fail-loud und
// kein halb angelegter Törn.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./helpers/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ requireAdminOrTripCreator: vi.fn(), isAdmin: vi.fn() }));

import { createTrip } from "@/lib/actions/trips";
import { isAdmin, requireAdminOrTripCreator } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const CREATOR = "aaaaaaaa-0000-4000-8000-000000000002";

function form() {
  const d = new FormData();
  d.set("name", "Testtörn");
  d.set("start_date", "2026-06-01");
  d.set("end_date", "2026-06-10");
  return d;
}

describe("createTrip — Skipper-Mitgliedschaft", () => {
  beforeEach(() => {
    vi.mocked(requireAdminOrTripCreator).mockResolvedValue({ ok: true, personId: CREATOR });
    vi.mocked(isAdmin).mockResolvedValue(false);
  });

  it("legt den Skipper als is_skipper-Mitglied an (Erfolgsfall)", async () => {
    const fake = createFakeSupabase();
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    await expect(createTrip({ status: "idle" }, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(fake.rows("trip_members")).toHaveLength(1);
    expect(fake.rows("trip_members")[0]).toMatchObject({ person_id: CREATOR, is_skipper: true });
    expect(fake.rows("trips")).toHaveLength(1);
  });

  it("scheitert der Mitgliedschafts-Insert → Fehlermeldung, Törn wieder entfernt", async () => {
    const fake = createFakeSupabase();
    fake.failOn({ table: "trip_members", action: "insert" });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    const res = await createTrip({ status: "idle" }, form());
    expect(res.status).toBe("error");
    expect(fake.rows("trips")).toHaveLength(0);
    expect(fake.rows("trip_categories")).toHaveLength(0);
  });
});
