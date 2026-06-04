/**
 * Tests für den Open-Redirect-Schutz (safeNextPath) aus lib/auth/origin.ts.
 */
import { describe, expect, it } from "vitest";
import { resolveOrigin, safeNextPath } from "@/lib/auth/origin";

describe("safeNextPath", () => {
  it("lässt interne, absolute Pfade durch", () => {
    expect(safeNextPath("/trips/123")).toBe("/trips/123");
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/profile?tab=x")).toBe("/profile?tab=x");
  });

  it("weist externe und protokoll-relative URLs ab", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("http://evil.com/path")).toBe("/");
  });

  it("fällt bei leerem/fehlendem Wert auf den Fallback zurück", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("relativ/ohne/slash")).toBe("/");
  });

  it("respektiert einen abweichenden Fallback", () => {
    expect(safeNextPath(null, "/login")).toBe("/login");
    expect(safeNextPath("//evil.com", "/login")).toBe("/login");
  });
});

describe("resolveOrigin — Env-Fallback (SITE_URL ?? APP_ORIGIN)", () => {
  /** Setzt eine Env-Variable temporär und stellt sie danach wieder her. */
  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      prev[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it("nutzt NEXT_PUBLIC_APP_ORIGIN, wenn NEXT_PUBLIC_SITE_URL fehlt", () => {
    // Genau die Prod-Konstellation, die den Invite-Crash verursachte:
    // SITE_URL nicht gesetzt, aber APP_ORIGIN vorhanden.
    withEnv(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        expect(resolveOrigin(null)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("bevorzugt NEXT_PUBLIC_SITE_URL vor APP_ORIGIN", () => {
    withEnv(
      { NEXT_PUBLIC_SITE_URL: "https://site.example.com", NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com" },
      () => {
        expect(resolveOrigin(null)).toBe("https://site.example.com");
      },
    );
  });
});
