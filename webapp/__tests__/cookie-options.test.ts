import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCookieOptions, sessionCookieOptions } from "@/lib/supabase/cookie-options";

/** Slice 13: Session-Cookies nur auf freigegebenen https-Hosts `Secure` (LAN-/http-Test darf nicht brechen). */
const h = (o: Record<string, string>) => new Headers(o);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://bordkasse.example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sessionCookieOptions", () => {
  it("setzt secure auf der freigegebenen https-Domain (Host-Header)", () => {
    expect(sessionCookieOptions(h({ host: "bordkasse.example.com" })).secure).toBe(true);
  });
  it("setzt secure hinter dem Proxy (x-forwarded-host, auch mit :443 und Großschreibung)", () => {
    expect(sessionCookieOptions(h({ "x-forwarded-host": "Bordkasse.Example.com:443", host: "0.0.0.0:3000" })).secure).toBe(true);
  });
  it("setzt KEIN secure auf der LAN-IP (http-Test am Handy)", () => {
    expect(sessionCookieOptions(h({ host: "192.168.1.20:3000" })).secure).toBe(false);
  });
  it("setzt KEIN secure auf localhost", () => {
    expect(sessionCookieOptions(h({ host: "localhost:3000" })).secure).toBe(false);
  });
  it("setzt KEIN secure bei fremdem Host oder fehlendem Header", () => {
    expect(sessionCookieOptions(h({ host: "evil.example.org" })).secure).toBe(false);
    expect(sessionCookieOptions(h({})).secure).toBe(false);
  });
  it("setzt KEIN secure, wenn der kanonische Origin http ist (lokale Env)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "http://localhost:3000");
    expect(sessionCookieOptions(h({ host: "localhost:3000" })).secure).toBe(false);
  });
});

describe("browserCookieOptions", () => {
  it("secure nur auf https", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    expect(browserCookieOptions().secure).toBe(true);
    vi.stubGlobal("location", { protocol: "http:" });
    expect(browserCookieOptions().secure).toBe(false);
  });
});
