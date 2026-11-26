// @vitest-environment happy-dom
/**
 * Regressions-Grill 2026-11: RealtimeTrip abonniert erst NACH geladener
 * Session (sonst läuft das Abo seit 0066 mit dem rechtelosen anon-Key),
 * räumt bei Unmount sauber auf (kein Abo nach Unmount, kein Doppel-Abo) und
 * loggt CHANNEL_ERROR/TIMED_OUT per console.warn ohne IDs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/toast-provider", () => ({ useToast: () => ({ show: () => {} }) }));

type StatusCb = (status: string) => void;
let resolveSession: () => void;
let subscribeCalls: StatusCb[];
let channelObj: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
const removeChannel = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => getSession() },
    channel: () => channelObj,
    removeChannel: (c: unknown) => removeChannel(c),
  }),
}));

import { RealtimeTrip } from "@/components/realtime-trip";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  subscribeCalls = [];
  channelObj = {
    on: vi.fn(() => channelObj),
    subscribe: vi.fn((cb: StatusCb) => {
      subscribeCalls.push(cb);
      return channelObj;
    }),
  };
  removeChannel.mockClear();
  getSession.mockReset();
  getSession.mockImplementation(
    () => new Promise<void>((r) => { resolveSession = r; }).then(() => ({ data: { session: null } })),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("RealtimeTrip — Abo erst nach der Session", () => {
  it("abonniert nicht, bevor getSession() fertig ist, danach genau einmal", async () => {
    act(() => root.render(h(RealtimeTrip, { tripId: TRIP, currentPersonId: "p" })));
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(channelObj.subscribe).not.toHaveBeenCalled();
    resolveSession();
    await flush();
    expect(channelObj.subscribe).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(removeChannel).toHaveBeenCalledWith(channelObj);
  });

  it("Unmount vor dem Ende von getSession(): kein Abo, nichts zu entfernen", async () => {
    act(() => root.render(h(RealtimeTrip, { tripId: TRIP })));
    act(() => root.unmount());
    resolveSession();
    await flush();
    expect(channelObj.subscribe).not.toHaveBeenCalled();
    expect(removeChannel).not.toHaveBeenCalled();
  });

  it("scheitert getSession(), wird trotzdem abonniert", async () => {
    getSession.mockImplementation(() => Promise.reject(new Error("x")));
    act(() => root.render(h(RealtimeTrip, { tripId: TRIP })));
    await flush();
    expect(channelObj.subscribe).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

describe("RealtimeTrip — Status-Callback", () => {
  it("loggt CHANNEL_ERROR und TIMED_OUT ohne Törn-ID, SUBSCRIBED nicht", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => root.render(h(RealtimeTrip, { tripId: TRIP })));
    resolveSession();
    await flush();
    const cb = subscribeCalls[0];
    expect(cb).toBeTypeOf("function");
    cb("SUBSCRIBED");
    expect(warn).not.toHaveBeenCalled();
    cb("CHANNEL_ERROR");
    cb("TIMED_OUT");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toContain("CHANNEL_ERROR");
    expect(warn.mock.calls[1]).toContain("TIMED_OUT");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TRIP);
    act(() => root.unmount());
  });
});
