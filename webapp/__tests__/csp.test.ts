import { describe, it, expect } from "vitest";
import { supabaseConnectSrc } from "@/lib/security/csp";

const FALLBACK = "https://*.supabase.co wss://*.supabase.co";

/**
 * Wächter für die `connect-src`-Ableitung (Umzug auf selbst gehostetes
 * Supabase). Ein Regress hier ist teuer: die App rendert weiter, nur
 * Realtime verbindet nicht mehr — ohne sichtbaren Fehler.
 */
describe("supabaseConnectSrc", () => {
  it("erlaubt den selbst gehosteten Host mit https UND wss", () => {
    const out = supabaseConnectSrc("https://sb.bordkasse.dieter.ms");
    expect(out).toBe("https://sb.bordkasse.dieter.ms wss://sb.bordkasse.dieter.ms");
  });

  it("nimmt den Port mit — lokal läuft Supabase auf :54321", () => {
    const out = supabaseConnectSrc("http://127.0.0.1:54321");
    expect(out).toBe("https://127.0.0.1:54321 wss://127.0.0.1:54321");
  });

  it("führt bei Cloud-URLs zum konkreten Projekt-Host", () => {
    const out = supabaseConnectSrc("https://abcdefgh.supabase.co");
    expect(out).toBe("https://abcdefgh.supabase.co wss://abcdefgh.supabase.co");
  });

  it("ignoriert Pfad-Anteile (CSP-Host-Ausdruck kennt keine Pfade)", () => {
    expect(supabaseConnectSrc("https://sb.example.org/rest/v1")).toBe(
      "https://sb.example.org wss://sb.example.org",
    );
  });

  // Ohne Env-Var (lokale Builds, CI) bleibt das Cloud-Muster erhalten,
  // damit ein Build ohne Supabase-Config nicht plötzlich alles blockt.
  it("fällt ohne Env-Var auf das Cloud-Wildcard zurück", () => {
    expect(supabaseConnectSrc(undefined)).toBe("https://*.supabase.co wss://*.supabase.co");
    expect(supabaseConnectSrc("")).toBe("https://*.supabase.co wss://*.supabase.co");
  });

  // Eine ungültige URL darf NICHT durchgereicht werden: die Direktive wäre
  // syntaktisch kaputt und der Browser verwürfe die gesamte CSP.
  it("fällt bei ungültiger URL auf das Wildcard zurück", () => {
    expect(supabaseConnectSrc("nicht-mal-eine-url")).toBe(
      "https://*.supabase.co wss://*.supabase.co",
    );
  });

  // `;` beendet in einer CSP die Direktive, `,` die ganze Policy — beide sind
  // aber gültige Host-Zeichen für new URL(). Ohne Positivliste könnte ein
  // Tippfehler in der Env-Var eine fremde Direktive anhängen.
  it("weist Hosts mit CSP-Trennzeichen ab", () => {
    expect(supabaseConnectSrc("https://a;script-src")).toBe(FALLBACK);
    expect(supabaseConnectSrc("https://a,b")).toBe(FALLBACK);
  });

  // userinfo gehört nicht zum Host — new URL() trennt das korrekt ab.
  it("übernimmt keine Zugangsdaten aus der URL", () => {
    expect(supabaseConnectSrc("https://user:pass@sb.example.org")).toBe(
      "https://sb.example.org wss://sb.example.org",
    );
  });

  it("erlaubt IPv6-Hosts in Klammern", () => {
    expect(supabaseConnectSrc("http://[::1]:54321")).toBe(
      "https://[::1]:54321 wss://[::1]:54321",
    );
  });

  it("ergibt immer genau zwei Sources, ohne Trennzeichen im Host", () => {
    for (const input of [
      "https://sb.bordkasse.dieter.ms",
      "http://127.0.0.1:54321",
      "https://user:pass@sb.example.org",
      "https://a;b",
      undefined,
      "kaputt",
    ]) {
      const parts = supabaseConnectSrc(input).split(" ");
      expect(parts).toHaveLength(2);
      expect(parts[0].startsWith("https://")).toBe(true);
      expect(parts[1].startsWith("wss://")).toBe(true);
      for (const p of parts) {
        expect(p).not.toMatch(/[;,]/);
      }
    }
  });
});
