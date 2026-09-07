// @vitest-environment happy-dom
//
// Logout-Aufräumen (Fund 5, PR 5). Vorher gab es dafür GAR KEINEN Code —
// `signOut()` beendete nur die Supabase-Session. Auf einem geteilten Gerät
// blieben Service-Worker-Caches, der Fremdwährungs-Kurscache und ein aktives
// Push-Abo der vorherigen Person bestehen. Dieses Modul existierte vor dem
// Fix schlicht nicht — der Import allein schlägt gegen den alten Stand fehl.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/profile/push-actions", () => ({
  deletePushSubscription: vi.fn(),
}));

import { cleanupOnLogout } from "@/lib/offline/logout-cleanup";
import { cacheRates, getCachedRate } from "@/lib/offline/rate-cache";
import { deletePushSubscription } from "@/app/profile/push-actions";

const mockedDeletePush = vi.mocked(deletePushSubscription);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  mockedDeletePush.mockReset();
});

describe("cleanupOnLogout (Fund 5, PR 5)", () => {
  it("löscht alle Service-Worker-Caches", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", {
      keys: async () => ["bordkasse-v13-pages", "bordkasse-v13-static"],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    });
    vi.stubGlobal("navigator", { serviceWorker: undefined });

    await cleanupOnLogout();

    expect(deleted.sort()).toEqual(["bordkasse-v13-pages", "bordkasse-v13-static"]);
  });

  it("löscht den Fremdwährungs-Kurscache (lib/offline/rate-cache.ts)", async () => {
    vi.stubGlobal("caches", { keys: async () => [], delete: async () => true });
    vi.stubGlobal("navigator", { serviceWorker: undefined });

    cacheRates("trip-1", [{ code: "SEK", rate: 0.09 }]);
    expect(getCachedRate("trip-1", "SEK")).toBe(0.09);

    await cleanupOnLogout();

    expect(getCachedRate("trip-1", "SEK")).toBeNull();
  });

  it("meldet ein vorhandenes eigenes Push-Abo ab", async () => {
    vi.stubGlobal("caches", { keys: async () => [], delete: async () => true });
    const unsubscribe = vi.fn().mockResolvedValue(true);
    mockedDeletePush.mockResolvedValue({ ok: true, deleted: true });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/x", unsubscribe }),
          },
        }),
      },
    });

    await cleanupOnLogout();

    expect(mockedDeletePush).toHaveBeenCalledWith("https://fcm.googleapis.com/x");
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("lässt ein FREMDES Abo auf einem geteilten Gerät unangetastet (deleted:false)", async () => {
    vi.stubGlobal("caches", { keys: async () => [], delete: async () => true });
    const unsubscribe = vi.fn();
    mockedDeletePush.mockResolvedValue({ ok: true, deleted: false });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/y", unsubscribe }),
          },
        }),
      },
    });

    await cleanupOnLogout();

    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("wirft nie, selbst wenn jeder Teilschritt fehlschlägt", async () => {
    vi.stubGlobal("caches", {
      keys: async () => {
        throw new Error("boom");
      },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => {
          throw new Error("boom");
        },
      },
    });

    await expect(cleanupOnLogout()).resolves.toBeUndefined();
  });
});
