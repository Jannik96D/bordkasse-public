import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginIntentCookieOptions,
  loginIntentMatches,
  loginIntentValue,
} from "@/lib/auth/login-intent";

beforeEach(() => vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("login-intent", () => {
  it("enthält keine Klartext-Adresse und ist normalisiert", () => {
    const v = loginIntentValue("Crew+Tag@Example.com");
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(v).not.toContain("crew");
    expect(loginIntentValue("  crew+tag@example.com ")).toBe(v);
    expect(loginIntentValue("crew tag@example.com")).toBe(v);
  });

  it("passt nur zur eigenen Adresse", () => {
    const v = loginIntentValue("a@example.com")!;
    expect(loginIntentMatches("A@example.com", v)).toBe(true);
    expect(loginIntentMatches("b@example.com", v)).toBe(false);
    expect(loginIntentMatches("a@example.com", undefined)).toBe(false);
    expect(loginIntentMatches(undefined, v)).toBe(false);
    expect(loginIntentMatches("a@example.com", v.slice(0, 10))).toBe(false);
  });

  it("hängt vom Secret ab und liefert ohne Secret null/false", () => {
    const v = loginIntentValue("a@example.com")!;
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "anderes-secret");
    expect(loginIntentMatches("a@example.com", v)).toBe(false);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(loginIntentValue("a@example.com")).toBeNull();
    expect(loginIntentMatches("a@example.com", v)).toBe(false);
  });

  it("Cookie-Optionen: HttpOnly, Lax, 60 Min, Secure nur in Production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const prod = loginIntentCookieOptions();
    expect(prod).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 3600, secure: true });
    vi.stubEnv("NODE_ENV", "development");
    expect(loginIntentCookieOptions().secure).toBe(false);
  });
});
