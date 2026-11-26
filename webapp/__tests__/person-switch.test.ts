// Slice 12 (Sicherheitsrunde 2026-11): Personenwechsel auf geteilten Geraeten.
import { describe, expect, it, vi } from "vitest";
import { decidePersonSwitch, reconcilePersonSwitch } from "@/lib/offline/person-switch";

describe("decidePersonSwitch", () => {
  it("gleiche Person: nichts", () => expect(decidePersonSwitch("a", "a")).toBe("none"));
  it("erste Anmeldung: nur merken", () => expect(decidePersonSwitch(null, "a")).toBe("remember"));
  it("andere Person: aufraeumen + merken", () =>
    expect(decidePersonSwitch("a", "b")).toBe("cleanup-and-remember"));
  it("ausgeloggt mit gemerkter Person: aufraeumen + vergessen", () =>
    expect(decidePersonSwitch("a", null)).toBe("cleanup-and-forget"));
  it("ausgeloggt ohne Merkwert: nichts", () => expect(decidePersonSwitch(null, null)).toBe("none"));
});

function deps(initial: string | null) {
  let stored = initial;
  const cleanup = vi.fn(async () => {});
  return {
    cleanup,
    get stored() {
      return stored;
    },
    d: { read: () => stored, write: (id: string | null) => void (stored = id), cleanup },
  };
}

describe("reconcilePersonSwitch", () => {
  it("Wechsel: raeumt auf und merkt die neue ID", async () => {
    const x = deps("a");
    await reconcilePersonSwitch("b", x.d);
    expect(x.cleanup).toHaveBeenCalledTimes(1);
    expect(x.stored).toBe("b");
  });
  it("gleiche Person: kein Aufraeumen", async () => {
    const x = deps("a");
    await reconcilePersonSwitch("a", x.d);
    expect(x.cleanup).not.toHaveBeenCalled();
    expect(x.stored).toBe("a");
  });
  it("erste Anmeldung: kein Aufraeumen, ID gemerkt", async () => {
    const x = deps(null);
    await reconcilePersonSwitch("a", x.d);
    expect(x.cleanup).not.toHaveBeenCalled();
    expect(x.stored).toBe("a");
  });
  it("Session weg: raeumt auf und vergisst", async () => {
    const x = deps("a");
    await reconcilePersonSwitch(null, x.d);
    expect(x.cleanup).toHaveBeenCalledTimes(1);
    expect(x.stored).toBeNull();
  });
  it("Cleanup wirft: kein Wurf nach aussen, alte ID bleibt", async () => {
    const x = deps("a");
    x.cleanup.mockRejectedValueOnce(new Error("boom"));
    await expect(reconcilePersonSwitch("b", x.d)).resolves.toBe("cleanup-and-remember");
    expect(x.stored).toBe("a");
  });
});
