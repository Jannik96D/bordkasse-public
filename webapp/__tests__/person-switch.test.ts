// @vitest-environment happy-dom
// Slice 12 (Sicherheitsrunde 2026-11): Personenwechsel auf geteilten Geraeten.
import { describe, expect, it, vi } from "vitest";
import {
  decidePersonSwitch,
  deleteThenCleanup,
  forgetLastPerson,
  LAST_PERSON_KEY,
  reconcilePersonSwitch,
  resolveProbe,
  shouldCheck,
  withTimeout,
  type PersonProbe,
} from "@/lib/offline/person-switch";

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

const noPause = async () => {};
const seq = (...r: (PersonProbe | "throw")[]) => {
  const fn = vi.fn(async () => {
    const x = r.shift()!;
    if (x === "throw") throw new Error("net");
    return x;
  });
  return fn;
};

describe("resolveProbe", () => {
  it("error → null, keine Bestaetigung noetig, nie aufraeumen", async () => {
    const p = seq({ status: "error" });
    expect(await resolveProbe(p, noPause, true)).toBeNull();
    expect(p).toHaveBeenCalledTimes(1);
  });
  it("Exception → null", async () => {
    expect(await resolveProbe(seq("throw"), noPause, true)).toBeNull();
  });
  it("person → id", async () => {
    expect(await resolveProbe(seq({ status: "person", id: "a" }), noPause, true)).toBe("a");
  });
  it("none + gemerkt: erst nach zweiter Bestaetigung none", async () => {
    const p = seq({ status: "none" }, { status: "none" });
    expect(await resolveProbe(p, noPause, true)).toBe("none");
    expect(p).toHaveBeenCalledTimes(2);
  });
  it("none dann person: Person gewinnt", async () => {
    expect(await resolveProbe(seq({ status: "none" }, { status: "person", id: "a" }), noPause, true)).toBe("a");
  });
  it("none dann error: unklar → null", async () => {
    expect(await resolveProbe(seq({ status: "none" }, { status: "error" }), noPause, true)).toBeNull();
  });
  it("none dann Exception: null", async () => {
    expect(await resolveProbe(seq({ status: "none" }, "throw"), noPause, true)).toBeNull();
  });
  it("none ohne gemerkte Person: keine zweite Abfrage", async () => {
    const p = seq({ status: "none" });
    expect(await resolveProbe(p, noPause, false)).toBe("none");
    expect(p).toHaveBeenCalledTimes(1);
  });
});

describe("shouldCheck / withTimeout", () => {
  it("Debounce", () => {
    expect(shouldCheck(1000, null, 30000)).toBe(true);
    expect(shouldCheck(10000, 1000, 30000)).toBe(false);
    expect(shouldCheck(31000, 1000, 30000)).toBe(true);
  });
  it("Timeout liefert Fallback bei haengender Action", async () => {
    vi.useFakeTimers();
    const r = withTimeout(new Promise<string>(() => {}), 8000, "fb");
    await vi.advanceTimersByTimeAsync(8000);
    expect(await r).toBe("fb");
    vi.useRealTimers();
  });
  it("schnelle Action gewinnt, Rejection → Fallback", async () => {
    expect(await withTimeout(Promise.resolve("ok"), 50, "fb")).toBe("ok");
    expect(await withTimeout(Promise.reject(new Error("x")), 50, "fb")).toBe("fb");
  });
});

describe("deleteThenCleanup", () => {
  it("Ablehnung: kein Cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    const r = await deleteThenCleanup(async () => ({ status: "error" as const }), cleanup);
    expect(r.status).toBe("error");
    expect(cleanup).not.toHaveBeenCalled();
  });
  it("Erfolg: Cleanup danach", async () => {
    const cleanup = vi.fn(async () => {});
    await deleteThenCleanup(async () => ({ status: "idle" as const }), cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("forgetLastPerson", () => {
  it("loescht den Merkwert", () => {
    window.localStorage.setItem(LAST_PERSON_KEY, "a");
    forgetLastPerson();
    expect(window.localStorage.getItem(LAST_PERSON_KEY)).toBeNull();
  });
});
