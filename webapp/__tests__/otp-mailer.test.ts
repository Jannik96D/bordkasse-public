// Sicherheitsrunde 2026-11, Slice 2: der Magic-Link-Versand läuft über den
// Service-Role-Key, weil Kong `/auth/v1/otp` für den anon-Key sperrt.
// Geprüft wird die Client-Fabrik selbst: Service-Role-Key, keine Session,
// kein Rückfall auf den anon-Key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ marker: "client" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { createOtpMailerClient } from "@/lib/supabase/otp-mailer";

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  createClient.mockClear();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createOtpMailerClient", () => {
  it("baut den Client mit dem Service-Role-Key, nie mit dem anon-Key", () => {
    const client = createOtpMailerClient();
    expect(client).toEqual({ marker: "client" });
    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, key] = createClient.mock.calls[0] as unknown as [string, string];
    expect(url).toBe("https://sb.example.test");
    expect(key).toBe("service-key");
    expect(key).not.toBe("anon-key");
  });

  it("hält keine Session (cookielos, kein Auto-Refresh, keine URL-Auswertung)", () => {
    createOtpMailerClient();
    const opts = (createClient.mock.calls[0] as unknown as [string, string, { auth: Record<string, unknown> }])[2];
    expect(opts.auth).toMatchObject({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
  });

  it("ohne Service-Role-Key → null statt Rückfall auf den anon-Key", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(createOtpMailerClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("ohne Supabase-URL → null", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(createOtpMailerClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
