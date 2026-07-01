// @vitest-environment happy-dom
//
// Persistenter Client-Kurs-Cache (localStorage) — Fallback, damit die erste
// Offline-Buchung einer Währung einen Kurs hat (Migration 0041).
import { beforeEach, describe, expect, it } from "vitest";
import { cacheRates, getCachedRate } from "@/lib/offline/rate-cache";

const TRIP_A = "trip-a";
const TRIP_B = "trip-b";

beforeEach(() => window.localStorage.clear());

describe("rate-cache", () => {
  it("speichert und liest einen Kurs zurück", () => {
    cacheRates(TRIP_A, [{ code: "SEK", rate: 0.0903 }]);
    expect(getCachedRate(TRIP_A, "SEK")).toBe(0.0903);
  });

  it("liefert null für unbekannte Währung / Törn", () => {
    cacheRates(TRIP_A, [{ code: "SEK", rate: 0.0903 }]);
    expect(getCachedRate(TRIP_A, "NOK")).toBeNull();
    expect(getCachedRate(TRIP_B, "SEK")).toBeNull();
  });

  it("hält Kurse pro Törn getrennt", () => {
    cacheRates(TRIP_A, [{ code: "SEK", rate: 0.09 }]);
    cacheRates(TRIP_B, [{ code: "SEK", rate: 0.10 }]);
    expect(getCachedRate(TRIP_A, "SEK")).toBe(0.09);
    expect(getCachedRate(TRIP_B, "SEK")).toBe(0.1);
  });

  it("mergt neue Kurse in einen bestehenden Törn und überschreibt", () => {
    cacheRates(TRIP_A, [{ code: "SEK", rate: 0.09 }]);
    cacheRates(TRIP_A, [{ code: "NOK", rate: 0.085 }, { code: "SEK", rate: 0.091 }]);
    expect(getCachedRate(TRIP_A, "NOK")).toBe(0.085);
    expect(getCachedRate(TRIP_A, "SEK")).toBe(0.091);
  });

  it("ignoriert ungültige Kurse (≤ 0)", () => {
    cacheRates(TRIP_A, [{ code: "SEK", rate: 0 }, { code: "NOK", rate: -1 }]);
    expect(getCachedRate(TRIP_A, "SEK")).toBeNull();
    expect(getCachedRate(TRIP_A, "NOK")).toBeNull();
  });
});
