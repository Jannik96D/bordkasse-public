// @vitest-environment happy-dom
//
// Der Heilpfad nach einem VAPID-Key-Wechsel. Hier kann ein Gerät seine
// Benachrichtigungen verlieren oder — schlimmer — das Abo einer ANDEREN Person
// auf einem geteilten Gerät zerstören. Deshalb pro Fehlerfall ein Test.
//
// `vi.mock` der Server-Actions ist zwingend: das Modul importiert sie, und über
// sie hinge `server-only` mit drin, das im Test nicht ladbar ist.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deletePushSubscription = vi.fn();
const savePushSubscription = vi.fn();

vi.mock("@/app/profile/push-actions", () => ({
  deletePushSubscription: (...a: unknown[]) => deletePushSubscription(...a),
  savePushSubscription: (...a: unknown[]) => savePushSubscription(...a),
}));

// Der Hook liest den Key beim Import als Modul-Konstante.
vi.stubEnv(
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
);

const { healStaleSubscription } = await import("@/components/use-push-subscription");

/** Minimal-Doubles für die Browser-Objekte. */
function makeOldSub(endpoint = "https://push.example/old") {
  return { endpoint, unsubscribe: vi.fn().mockResolvedValue(true) } as unknown as PushSubscription & {
    unsubscribe: ReturnType<typeof vi.fn>;
  };
}

function makeReg(subscribeImpl?: () => Promise<unknown>) {
  const fresh = {
    endpoint: "https://push.example/new",
    toJSON: () => ({ endpoint: "https://push.example/new" }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const subscribe = vi.fn(subscribeImpl ?? (async () => fresh));
  return {
    reg: { pushManager: { subscribe } } as unknown as ServiceWorkerRegistration,
    subscribe,
    fresh,
  };
}

beforeEach(() => {
  deletePushSubscription.mockReset();
  savePushSubscription.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("healStaleSubscription", () => {
  it("ersetzt ein eigenes veraltetes Abo — und löscht die alte Zeile ZUERST", async () => {
    const order: string[] = [];
    deletePushSubscription.mockImplementation(async () => {
      order.push("delete");
      return { ok: true, deleted: true };
    });
    savePushSubscription.mockImplementation(async () => {
      order.push("save");
      return { ok: true };
    });
    const oldSub = makeOldSub();
    oldSub.unsubscribe.mockImplementation(async () => {
      order.push("unsubscribe");
      return true;
    });
    const { reg, subscribe } = makeReg();

    await expect(healStaleSubscription(reg, oldSub)).resolves.toBe("healed");

    // Die Reihenfolge ist die eigentliche Zusicherung: erst löschen, dann
    // abmelden. Andersherum bliebe bei einem Abbruch dazwischen genau die tote
    // Zeile stehen, die diese Funktion beseitigen soll.
    expect(order).toEqual(["delete", "unsubscribe", "save"]);
    expect(deletePushSubscription).toHaveBeenCalledWith("https://push.example/old");
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("lässt ein FREMDES Abo auf einem geteilten Gerät unangetastet", async () => {
    // deleted:false = die Zeile gehörte jemand anderem (Server filtert auf
    // person_id). Ohne diese Prüfung würden wir ohne jede Nutzeraktion das Abo
    // eines anderen Familienmitglieds abmelden und überschreiben.
    deletePushSubscription.mockResolvedValue({ ok: true, deleted: false });
    const oldSub = makeOldSub();
    const { reg, subscribe } = makeReg();

    await expect(healStaleSubscription(reg, oldSub)).resolves.toBe("not-ours");

    expect(oldSub.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(savePushSubscription).not.toHaveBeenCalled();
  });

  it("fasst nichts an, wenn das Löschen fehlschlägt (z. B. abgelaufene Session)", async () => {
    // Wichtig: die Action WIRFT nicht, sie liefert {ok:false} — ein blosses
    // `.catch()` würde das übersehen.
    deletePushSubscription.mockResolvedValue({ ok: false, message: "Nicht angemeldet." });
    const oldSub = makeOldSub();
    const { reg, subscribe } = makeReg();

    await expect(healStaleSubscription(reg, oldSub)).resolves.toBe("failed");

    expect(oldSub.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("hinterlässt keine Waise, wenn subscribe() scheitert", async () => {
    deletePushSubscription.mockResolvedValue({ ok: true, deleted: true });
    const oldSub = makeOldSub();
    const { reg } = makeReg(async () => {
      throw new Error("push service unreachable");
    });

    await expect(healStaleSubscription(reg, oldSub)).resolves.toBe("failed");

    // Zeile ist weg UND Browser-Abo ist weg → konsistenter Zustand, aus dem
    // der Nutzer per „Neu aktivieren" wieder herauskommt.
    expect(deletePushSubscription).toHaveBeenCalledTimes(1);
    expect(oldSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(savePushSubscription).not.toHaveBeenCalled();
  });

  it("nimmt das frische Abo zurück, wenn das Speichern scheitert", async () => {
    deletePushSubscription.mockResolvedValue({ ok: true, deleted: true });
    savePushSubscription.mockResolvedValue({ ok: false, message: "DB weg" });
    const oldSub = makeOldSub();
    const { reg, fresh } = makeReg();

    await expect(healStaleSubscription(reg, oldSub)).resolves.toBe("failed");

    // Sonst hätte der Browser ein Abo, zu dem es keine Zeile gibt — es käme
    // nie etwas an, und die UI meldete trotzdem „aktiv".
    expect(fresh.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
