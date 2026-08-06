// @vitest-environment happy-dom
//
// VAPID-Key-Rotation: erkennt der Client ein Abo, das noch mit einem ALTEN
// Schlüssel erzeugt wurde?
//
// Hintergrund: Werden die VAPID-Keys gewechselt, bleiben bestehende Abos
// technisch bestehen — der Push-Dienst lehnt den Versand aber mit HTTP 403 ab.
// Genau 403 räumt `lib/notify/web-push.ts` NICHT auf (nur 404/410), die toten
// Abos blieben also für immer in der DB und jede Zustellung liefe stumm ins
// Leere. `vapidKeyMatches` ist die Weiche, an der der Client das erkennt und
// das Abo still erneuert.
import { describe, expect, it, vi } from "vitest";
import { vapidKeyMatches } from "@/lib/push/vapid";

/** base64url → ArrayBuffer, wie ihn der Browser in `sub.options` liefert. */
function keyToBuffer(base64url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

// Zwei realistisch geformte (65 Byte, 0x04-Präfix) P-256-Public-Keys in
// base64url — Inhalt egal, nur die Bytes müssen sich unterscheiden.
const KEY_A =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const KEY_B =
  "BCmti7ScwxxVAlB7WAyxoOXtV7J8VZmwPPvvOF6dwd_5MDDZ5RVLLTLbXcyJPHMDgUVKlPRDLzsWJ0hOd_TjKgY";

describe("vapidKeyMatches", () => {
  it("erkennt ein Abo mit dem aktuellen Schlüssel als gültig", () => {
    expect(vapidKeyMatches(keyToBuffer(KEY_A), KEY_A)).toBe(true);
  });

  it("erkennt ein Abo mit einem ALTEN Schlüssel als veraltet", () => {
    // Der Fall nach einem Key-Wechsel: Gerät hat noch KEY_A, Server nutzt KEY_B.
    expect(vapidKeyMatches(keyToBuffer(KEY_A), KEY_B)).toBe(false);
  });

  it("meldet 'unbekannt' statt 'veraltet', wenn der Browser den Key nicht herausgibt", () => {
    // Wichtig: NICHT false. Sonst würde bei jedem Laden ein vorhandenes,
    // funktionierendes Abo unnötig neu angelegt.
    expect(vapidKeyMatches(null, KEY_A)).toBeNull();
    expect(vapidKeyMatches(undefined, KEY_A)).toBeNull();
  });

  it("meldet 'unbekannt', wenn gar kein VAPID-Key konfiguriert ist", () => {
    // Genau der aktuelle Produktionszustand vor dem Nachtragen der Keys —
    // hier darf nichts angefasst werden.
    expect(vapidKeyMatches(keyToBuffer(KEY_A), undefined)).toBeNull();
    expect(vapidKeyMatches(keyToBuffer(KEY_A), "")).toBeNull();
  });

  it("meldet 'unbekannt' statt zu werfen, wenn der konfigurierte Key kaputt ist", () => {
    // Realistisch beim Eintragen in die Env (abgeschnitten / Tippfehler).
    // `atob` würde werfen; der Fehler flöge bis in den Effekt-Catch des Hooks
    // und JEDES Gerät meldete „Browser unterstützt kein Push" — eine Diagnose,
    // die auf den Browser zeigt statt auf die Konfiguration.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(vapidKeyMatches(keyToBuffer(KEY_A), "nicht~gültiges~base64!")).toBeNull();
    spy.mockRestore();
  });
});
