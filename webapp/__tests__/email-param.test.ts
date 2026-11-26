import { describe, expect, it } from "vitest";
import { displayableEmail, normalizeEmail } from "@/lib/auth/email-param";

describe("normalizeEmail", () => {
  it("trimmt, kleinschreibt und macht Leerzeichen wieder zu +", () => {
    expect(normalizeEmail("  Crew tag@Example.com ")).toBe("crew+tag@example.com");
  });
});

describe("displayableEmail", () => {
  it("zeigt normale Adressen an", () => {
    expect(displayableEmail("crew@example.com")).toBe("crew@example.com");
  });
  it("blendet Fließtext, HTML und Überlanges aus", () => {
    expect(displayableEmail("Dein Konto ist gesperrt, ruf an")).toBeNull();
    expect(displayableEmail("<b>x</b>@a.de")).toBeNull();
    expect(displayableEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
    expect(displayableEmail(undefined)).toBeNull();
    expect(displayableEmail("")).toBeNull();
  });
});
