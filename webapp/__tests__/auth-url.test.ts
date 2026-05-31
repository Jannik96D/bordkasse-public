/**
 * Tests für den Open-Redirect-Schutz (safeNextPath) aus lib/auth/origin.ts.
 */
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/origin";

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
