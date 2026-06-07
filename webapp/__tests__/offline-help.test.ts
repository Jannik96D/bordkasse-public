// @vitest-environment happy-dom
//
// Offline-Hilfe (lib/offline/offline-help.ts): Cache-Preflight + Fehler-Flag.
// Die echte Cache API gibt es in happy-dom nicht → `caches` wird gestubbt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isFormCached,
  markOfflineMiss,
  readOfflineMiss,
  clearOfflineMiss,
  OFFLINE_MISS_KEY,
} from "@/lib/offline/offline-help";

// Minimaler Cache-API-Stub: store = Cache-Name → Liste vorhandener URLs.
function stubCaches(store: Record<string, string[]>) {
  vi.stubGlobal("caches", {
    keys: async () => Object.keys(store),
    open: async (name: string) => ({
      match: async (url: string) => {
        const path = url.split("?")[0]; // ignoreSearch
        const urls = store[name] ?? [];
        return urls.some((u) => u.split("?")[0] === path) ? {} : undefined;
      },
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isFormCached", () => {
  const FORM = "/trips/t1/transactions/new";

  it("false ohne Cache-API", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await isFormCached(FORM)).toBe(false);
  });

  it("true, wenn das Formular in einem -pages-Cache liegt", async () => {
    stubCaches({ "bordkasse-v9-pages": [FORM], "bordkasse-v9-static": [] });
    expect(await isFormCached(FORM)).toBe(true);
  });

  it("false, wenn nicht gecacht", async () => {
    stubCaches({ "bordkasse-v9-pages": ["/trips/t1/balance"] });
    expect(await isFormCached(FORM)).toBe(false);
  });

  it("ignoriert Caches, die nicht auf -pages enden", async () => {
    stubCaches({ "bordkasse-v9-static": [FORM] });
    expect(await isFormCached(FORM)).toBe(false);
  });

  it("trifft trotz ?draft=-Query (ignoreSearch)", async () => {
    stubCaches({ "bordkasse-v9-pages": [FORM] });
    expect(await isFormCached(`${FORM}?draft=abc`)).toBe(true);
  });

  it("wirft nie — Fehler beim Cache-Zugriff → false", async () => {
    vi.stubGlobal("caches", {
      keys: async () => {
        throw new Error("boom");
      },
    });
    expect(await isFormCached(FORM)).toBe(false);
  });
});

describe("offline-miss flag", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("mark → read liefert den Pfad zurück", () => {
    markOfflineMiss("/trips/t1/transactions/new");
    const miss = readOfflineMiss();
    expect(miss?.path).toBe("/trips/t1/transactions/new");
    expect(typeof miss?.at).toBe("number");
  });

  it("clear entfernt das Flag", () => {
    markOfflineMiss("/x");
    clearOfflineMiss();
    expect(readOfflineMiss()).toBeNull();
  });

  it("read ist null ohne Flag", () => {
    expect(readOfflineMiss()).toBeNull();
  });

  it("read ist null bei kaputtem JSON", () => {
    window.localStorage.setItem(OFFLINE_MISS_KEY, "{kein json");
    expect(readOfflineMiss()).toBeNull();
  });

  it("read ist null bei unvollständigem Objekt", () => {
    window.localStorage.setItem(OFFLINE_MISS_KEY, JSON.stringify({ at: 1 }));
    expect(readOfflineMiss()).toBeNull();
  });
});
