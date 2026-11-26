import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** Slice 13: proxy() und der Browser-Client reichen cookieOptions wirklich an @supabase/ssr durch. */
const createServerClient = vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: { id: "u" } } }) } }));
const createBrowserClient = vi.fn(() => ({}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (...a: unknown[]) => (createServerClient as (...x: unknown[]) => unknown)(...a),
  createBrowserClient: (...a: unknown[]) => (createBrowserClient as (...x: unknown[]) => unknown)(...a),
}));

type Call = [string, string, { cookieOptions?: { secure?: boolean } }];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://bordkasse.example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  createServerClient.mockClear();
  createBrowserClient.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function proxySecure(host: string, extra: Record<string, string> = {}) {
  const { proxy } = await import("@/proxy");
  await proxy(new NextRequest("http://0.0.0.0:3000/", { headers: { host, ...extra } }));
  return (createServerClient.mock.calls[0] as unknown as Call)[2].cookieOptions?.secure;
}

describe("proxy()", () => {
  it("Domain: secure = true", async () => {
    expect(await proxySecure("bordkasse.example.com")).toBe(true);
  });
  it("LAN-IP: secure = false", async () => {
    expect(await proxySecure("192.168.1.20:3000")).toBe(false);
  });
  it("Mehrfach-Proxy (x-forwarded-host: a, b): erster Eintrag zählt", async () => {
    expect(await proxySecure("0.0.0.0:3000", { "x-forwarded-host": "bordkasse.example.com, internal.proxy" })).toBe(true);
  });
  it("leere Allowlist: secure bleibt false (fail-open)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "");
    expect(await proxySecure("bordkasse.example.com")).toBe(false);
  });
});

describe("Browser-Client", () => {
  it("reicht cookieOptions.secure nach Protokoll durch", async () => {
    const { createClient } = await import("@/lib/supabase/client");
    vi.stubGlobal("location", { protocol: "https:" });
    createClient();
    vi.stubGlobal("location", { protocol: "http:" });
    createClient();
    const calls = createBrowserClient.mock.calls as unknown as Call[];
    expect(calls[0][2].cookieOptions?.secure).toBe(true);
    expect(calls[1][2].cookieOptions?.secure).toBe(false);
  });
});
