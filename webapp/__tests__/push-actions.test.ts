// SSRF-/Validierungs-Guard für savePushSubscription: der endpoint wird
// serverseitig per web-push angefragt, darf also NUR auf echte Push-Dienste
// zeigen (https-only Allowlist) — niemals interne Hosts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { savePushSubscription } from "@/app/profile/push-actions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAdmin = vi.mocked(createAdminClient);

describe("savePushSubscription — Endpoint-Validierung (SSRF)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAdmin.mockReset();
  });

  it("weist interne / Nicht-Push / http-Endpoints ab, OHNE die DB zu berühren", async () => {
    mockedPerson.mockResolvedValue({ id: "p1" } as never);
    const bad = [
      "http://169.254.169.254/latest/meta-data", // Cloud-Metadata
      "https://10.0.0.5:9200/notify", // internes Netz
      "http://localhost/x",
      "https://evil.example.com/x", // fremder Host
      "http://fcm.googleapis.com/fcm/send/x", // richtiger Host, aber http
    ];
    for (const endpoint of bad) {
      const res = await savePushSubscription({ endpoint, keys: { p256dh: "k", auth: "a" } });
      expect(res).toEqual({ ok: false, message: "Ungültiges Abo." });
    }
    expect(mockedAdmin).not.toHaveBeenCalled();
  });

  it("akzeptiert echte Push-Dienst-Endpoints (FCM/Apple/Mozilla/WNS)", async () => {
    mockedPerson.mockResolvedValue({ id: "p1" } as never);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mockedAdmin.mockReturnValue({ from: () => ({ upsert }) } as never);
    const good = [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://web.push.apple.com/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-by3p.notify.windows.com/w/?token=abc",
    ];
    for (const endpoint of good) {
      const res = await savePushSubscription({ endpoint, keys: { p256dh: "k", auth: "a" } });
      expect(res).toEqual({ ok: true });
    }
    expect(upsert).toHaveBeenCalledTimes(good.length);
  });
});
