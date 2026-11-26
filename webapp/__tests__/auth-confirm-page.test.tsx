/**
 * Render-Test für /auth/confirm: im Ein-Klick-Modus nur mit passendem
 * Login-Intent-Cookie, sonst Eingabefeld ohne Vorbelegung und OHNE Anzeige der
 * (fälschbaren) URL-Adresse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loginIntentCookieName, loginIntentValue } from "@/lib/auth/login-intent";

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === loginIntentCookieName() && cookieValue ? { name, value: cookieValue } : undefined,
  }),
}));
vi.mock("next/image", () => ({ default: () => null }));

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret");
  cookieValue = undefined;
});
afterEach(() => vi.unstubAllEnvs());

async function render(params: Record<string, string>) {
  const { default: ConfirmPage } = await import("@/app/auth/confirm/page");
  const element = await ConfirmPage({
    searchParams: Promise.resolve({ token_hash: "t", type: "email", ...params }),
  });
  return renderToStaticMarkup(createElement("div", null, element));
}

describe("/auth/confirm", () => {
  it("ohne Cookie: keine Anzeige der URL-Adresse, Eingabefeld ohne Vorbelegung", async () => {
    const html = await render({ email: "angreifer@example.com" });
    expect(html).not.toContain("Du meldest dich an als");
    expect(html).not.toContain("angreifer@example.com");
    expect(html).toContain('name="typed_email"');
    expect(html).not.toMatch(/name="typed_email"[^>]*value=/);
  });

  it("mit passendem Cookie: Ein-Klick-Modus mit Anzeige, ohne Eingabefeld", async () => {
    cookieValue = loginIntentValue("crew@example.com")!;
    const html = await render({ email: "crew@example.com" });
    expect(html).toContain("Du meldest dich an als");
    expect(html).toContain("crew@example.com");
    expect(html).not.toContain('name="typed_email"');
  });

  it("Cookie einer anderen Adresse: Fallback statt Ein-Klick", async () => {
    cookieValue = loginIntentValue("opfer@example.com")!;
    const html = await render({ email: "angreifer@example.com" });
    expect(html).not.toContain("Du meldest dich an als");
    expect(html).toContain('name="typed_email"');
  });

  it("typed_error zeigt den Hinweis, ohne eine Adresse zu spiegeln", async () => {
    const html = await render({ email: "angreifer@example.com", typed_error: "1" });
    expect(html).toContain("noch nicht");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("angreifer@example.com");
  });
});
