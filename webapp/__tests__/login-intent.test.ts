import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginIntentCookieName,
  loginIntentCookieOptions,
  loginIntentMatches,
  loginIntentValue,
} from "@/lib/auth/login-intent";

const NOW = 1_800_000_000_000;

beforeEach(() => vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("login-intent", () => {
  it("enthält keine Klartext-Adresse und ist normalisiert", () => {
    const v = loginIntentValue("Crew+Tag@Example.com", NOW);
    expect(v).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(v).not.toContain("crew");
    expect(loginIntentValue("  crew+tag@example.com ", NOW)).toBe(v);
    expect(loginIntentValue("crew tag@example.com", NOW)).toBe(v);
  });

  it("passt nur zur eigenen Adresse", () => {
    const v = loginIntentValue("a@example.com", NOW)!;
    expect(loginIntentMatches("A@example.com", v, NOW)).toBe(true);
    expect(loginIntentMatches("b@example.com", v, NOW)).toBe(false);
    expect(loginIntentMatches("a@example.com", undefined, NOW)).toBe(false);
    expect(loginIntentMatches(undefined, v, NOW)).toBe(false);
    expect(loginIntentMatches("a@example.com", v.slice(0, 20), NOW)).toBe(false);
  });

  it("prüft das Alter serverseitig (60 Min) und lehnt Zukunft ab", () => {
    const v = loginIntentValue("a@example.com", NOW)!;
    expect(loginIntentMatches("a@example.com", v, NOW + 59 * 60 * 1000)).toBe(true);
    expect(loginIntentMatches("a@example.com", v, NOW + 61 * 60 * 1000)).toBe(false);
    expect(loginIntentMatches("a@example.com", v, NOW - 10 * 60 * 1000)).toBe(false);
  });

  it("ein manipulierter Zeitstempel entwertet den HMAC", () => {
    const v = loginIntentValue("a@example.com", NOW)!;
    const [ts, mac] = v.split(".");
    expect(loginIntentMatches("a@example.com", `${Number(ts) + 5}.${mac}`, NOW)).toBe(false);
  });

  it("hängt vom Secret ab und liefert ohne Secret null/false", () => {
    const v = loginIntentValue("a@example.com", NOW)!;
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "anderes-secret");
    expect(loginIntentMatches("a@example.com", v, NOW)).toBe(false);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(loginIntentValue("a@example.com", NOW)).toBeNull();
    expect(loginIntentMatches("a@example.com", v, NOW)).toBe(false);
  });

  it("Cookie-Optionen: HttpOnly, Lax, 60 Min, Path /, Secure nur in Production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loginIntentCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      maxAge: 3600,
      secure: true,
      path: "/",
    });
    expect(loginIntentCookieOptions()).not.toHaveProperty("domain");
    vi.stubEnv("NODE_ENV", "development");
    expect(loginIntentCookieOptions().secure).toBe(false);
  });

  it("Cookie-Name: __Host- nur in Production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loginIntentCookieName()).toBe("__Host-bk_login_intent");
    vi.stubEnv("NODE_ENV", "development");
    expect(loginIntentCookieName()).toBe("bk_login_intent");
  });
});
