import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Slice 13: der Server-Client reicht die Secure-Entscheidung wirklich an @supabase/ssr durch. */
const createServerClient = vi.fn(() => ({}));
let hdrs = new Headers();
vi.mock("@supabase/ssr", () => ({ createServerClient: (...a: unknown[]) => (createServerClient as (...x: unknown[]) => unknown)(...a) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
  headers: async () => hdrs,
}));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://bordkasse.example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  createServerClient.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

async function optionsFor(host: string) {
  hdrs = new Headers({ host });
  const { createClient } = await import("@/lib/supabase/server");
  await createClient();
  return (createServerClient.mock.calls[0] as unknown as [string, string, { cookieOptions?: { secure?: boolean } }])[2].cookieOptions;
}

it("Domain: cookieOptions.secure = true", async () => {
  expect((await optionsFor("bordkasse.example.com"))?.secure).toBe(true);
});
it("LAN-IP: cookieOptions.secure = false", async () => {
  expect((await optionsFor("192.168.1.20:3000"))?.secure).toBe(false);
});
