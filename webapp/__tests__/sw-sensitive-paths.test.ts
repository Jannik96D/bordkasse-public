// Slice 12: der Service Worker darf /auth/* und /profile nie cachen/ausliefern.
// Der SW wird als Quelltext in einem vm-Kontext mit minimalen Stubs ausgefuehrt.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Handler = (e: unknown) => void;

function loadSw() {
  const listeners: Record<string, Handler> = {};
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (t: string, h: Handler) => void (listeners[t] = h),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const src = readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
  const cache = { match: async () => undefined, put: async () => {} };
  const caches = { open: async () => cache, match: async () => undefined };
  const fetchStub = async () => ({ ok: false, redirected: false });
  vm.runInNewContext(src, { self, URL, caches, fetch: fetchStub, console });
  return listeners.fetch;
}

function fire(fetchHandler: Handler, pathname: string, headers: Record<string, string> = {}) {
  let responded = false;
  fetchHandler({
    request: {
      method: "GET",
      url: "https://app.test" + pathname,
      mode: "navigate",
      headers: { get: (k: string) => headers[k] ?? null },
    },
    respondWith: () => void (responded = true),
  });
  return responded;
}

describe("sw.js: personenbezogene Pfade", () => {
  const h = loadSw();
  for (const p of ["/profile", "/profile/", "/profile/x", "/auth/confirm", "/auth/verify"]) {
    it(p + " wird nicht abgefangen (Dokument)", () => expect(fire(h, p)).toBe(false));
  }
  it("/profile wird auch als RSC-Request nicht abgefangen", () =>
    expect(fire(h, "/profile?_rsc=1", { RSC: "1" })).toBe(false));
  it("Kontrolle: Toern-Seiten werden weiter abgefangen", () =>
    expect(fire(h, "/trips/abc/balance")).toBe(true));
  it("Kontrolle: /profilexyz ist kein Profilpfad", () => expect(fire(h, "/profilexyz")).toBe(true));
});
