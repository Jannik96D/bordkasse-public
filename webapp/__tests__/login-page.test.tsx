/**
 * /login darf eine Adresse aus `?email=` nur vorbelegen, wenn das Login-Intent-
 * Cookie dieses Browsers dazu passt. Sonst könnte ein präparierter Link das
 * Opfer per Klick das Cookie für die Angreifer-Adresse setzen lassen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loginIntentCookieName, loginIntentValue } from "@/lib/auth/login-intent";

let cookieValue: string | undefined;
let query = "";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === loginIntentCookieName() && cookieValue ? { name, value: cookieValue } : undefined,
  }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/app/login/actions", () => ({ signInWithMagicLink: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret");
  cookieValue = undefined;
});
afterEach(() => vi.unstubAllEnvs());

async function render(params: Record<string, string>) {
  query = new URLSearchParams(params).toString();
  const { default: LoginPage } = await import("@/app/login/page");
  const element = await LoginPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(createElement("div", null, element));
}

describe("/login — keine Vorbelegung aus dem URL-Parameter", () => {
  it("ohne Cookie: weder Formular-Vorbelegung noch Resend-Knopf mit fremder Adresse", async () => {
    const html = await render({ email: "angreifer@example.com", auth_error: "otp_expired" });
    expect(html).not.toContain("angreifer@example.com");
    expect(html).not.toContain("Neuen Link an");
    expect(html).toContain('id="email"');
  });

  it("Cookie einer anderen Adresse: ebenfalls keine Übernahme", async () => {
    cookieValue = loginIntentValue("opfer@example.com")!;
    const html = await render({ email: "angreifer@example.com", auth_error: "otp_expired" });
    expect(html).not.toContain("angreifer@example.com");
  });

  it("mit passendem Cookie: Resend-Knopf und Vorbelegung für die eigene Adresse", async () => {
    cookieValue = loginIntentValue("crew@example.com")!;
    const html = await render({ email: "crew@example.com", auth_error: "otp_expired" });
    expect(html).toContain("Neuen Link an crew@example.com senden");
  });
});
