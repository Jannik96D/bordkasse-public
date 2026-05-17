import { describe, expect, it } from "vitest";
import { safeMathEval } from "@/lib/utils/math-eval";

describe("safeMathEval — gültige Eingaben", () => {
  it("akzeptiert einfache Dezimalzahl mit Komma", () => {
    expect(safeMathEval("12,50")).toBe(12.5);
  });

  it("akzeptiert einfache Dezimalzahl mit Punkt", () => {
    expect(safeMathEval("12.50")).toBe(12.5);
  });

  it("rechnet Addition", () => {
    expect(safeMathEval("3 + 17")).toBe(20);
  });

  it("rechnet Addition mit Dezimalzahlen", () => {
    expect(safeMathEval("9,80 + 4,20")).toBe(14);
  });

  it("rechnet Multiplikation", () => {
    expect(safeMathEval("2 * 4,50")).toBe(9);
  });

  it("rechnet Klammern", () => {
    expect(safeMathEval("(3 + 5) * 2")).toBe(16);
  });

  it("rechnet Subtraktion mit Dezimalstellen", () => {
    expect(safeMathEval("12,5 - 2")).toBe(10.5);
  });

  it("rundet auf 2 Nachkommastellen", () => {
    expect(safeMathEval("10 / 3")).toBe(3.33);
  });

  it("ignoriert Whitespace", () => {
    expect(safeMathEval("  3   +   17  ")).toBe(20);
  });
});

describe("safeMathEval — ungültige Eingaben", () => {
  it("lehnt Buchstaben ab", () => {
    expect(safeMathEval("abc")).toBeNull();
  });

  it("lehnt Buchstaben in Zahl ab", () => {
    expect(safeMathEval("1a")).toBeNull();
  });

  it("lehnt leere Eingabe ab", () => {
    expect(safeMathEval("")).toBeNull();
  });

  it("lehnt nur Whitespace ab", () => {
    expect(safeMathEval("   ")).toBeNull();
  });

  it("lehnt nur Operatoren ohne Zahlen ab", () => {
    expect(safeMathEval("+ - *")).toBeNull();
  });

  it("lehnt Semikolon ab", () => {
    expect(safeMathEval("1; 1")).toBeNull();
  });

  it("lehnt JS-Funktionsaufrufe ab", () => {
    expect(safeMathEval("alert(1)")).toBeNull();
  });

  it("lehnt eval-ähnliche Konstrukte ab", () => {
    expect(safeMathEval("constructor")).toBeNull();
  });

  it("lehnt negative Ergebnisse ab", () => {
    expect(safeMathEval("5 - 10")).toBeNull();
  });

  it("lehnt Division durch Null ab", () => {
    expect(safeMathEval("1 / 0")).toBeNull();
  });

  it("lehnt unvollständige Ausdrücke ab", () => {
    expect(safeMathEval("3 +")).toBeNull();
  });
});
