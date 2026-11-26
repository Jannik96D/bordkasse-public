// Slice 10: der tägliche Purge-Cron räumt verwaiste Auth-Konten auf und meldet
// die Zahl (und Fehler getrennt) im JSON — ein Aufräum-Fehler kippt den Purge nie.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/orphan-accounts", () => ({ cleanupOrphanAuthUsers: vi.fn() }));

import { GET } from "@/app/api/cron/purge/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanupOrphanAuthUsers } from "@/lib/auth/orphan-accounts";
import type { NextRequest } from "next/server";

// Zur Laufzeit erzeugt (kein Literal im Repo, kein Secret-Scanner-Fehlalarm).
const SECRET = randomBytes(24).toString("hex");

function req() {
  return { headers: new Headers({ authorization: `Bearer ${SECRET}` }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data: [{ purged: 2, failed: 0 }], error: null }),
  } as never);
});

describe("Purge-Cron — verwaiste Auth-Konten", () => {
  it("nennt die Zahl aufgeräumter Konten im Response", async () => {
    vi.mocked(cleanupOrphanAuthUsers).mockResolvedValue({ deleted: 3, failed: 0 });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, purged_trips: 2, orphan_accounts_deleted: 3, orphan_accounts_failed: 0 });
  });

  it("ein Fehler beim Aufräumen zählt separat und bricht den Purge nicht ab", async () => {
    vi.mocked(cleanupOrphanAuthUsers).mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, purged_trips: 2, orphan_accounts_deleted: 0, orphan_accounts_failed: 1 });
  });
});
