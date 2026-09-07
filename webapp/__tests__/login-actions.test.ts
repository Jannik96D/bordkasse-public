// Login-Rate-Limit (PR 8): IP-Ermittlung + Oracle-Schutz bei Überschreitung.
//
// Folgt dem Mock-Muster aus transaction-actions.test.ts: "server-only" +
// Supabase-/Next-Abhängigkeiten werden gemockt, sodass die Server-Action ohne
// echte DB/Request-Kontext getestet werden kann.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ isEmailAllowedToSignIn: vi.fn() }));
vi.mock("@/lib/auth/origin", () => ({ resolveOrigin: vi.fn(() => "https://bordkasse.dieter.ms") }));

import { signInWithMagicLink, type LoginState } from "@/app/login/actions";
import { resolveClientIp } from "@/lib/auth/client-ip";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEmailAllowedToSignIn } from "@/lib/auth/authz";

const mockedHeaders = vi.mocked(headers);
const mockedCreateClient = vi.mocked(createClient);
const mockedAdminClient = vi.mocked(createAdminClient);
const mockedAllowed = vi.mocked(isEmailAllowedToSignIn);

const IDLE: LoginState = { status: "idle" };

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function makeFormData(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
}

/** Admin-Client-Mock, dessen `bump_login_rate_limit`-RPC `allowed` liefert. */
function makeAdmin(allowed: boolean) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: allowed, error: null }),
  };
}

const signInWithOtp = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateClient.mockResolvedValue({
    auth: { signInWithOtp },
  } as unknown as ReturnType<typeof createClient> extends Promise<infer T> ? T : never);
  signInWithOtp.mockResolvedValue({ error: null });
  mockedAllowed.mockResolvedValue(true);
});

describe("resolveClientIp", () => {
  it("bevorzugt den LETZTEN x-forwarded-for-Eintrag vor x-real-ip (Grill-Review-Korrektur: x-real-ip ist ohne belegte Traefik-Konfiguration nicht vertrauenswürdig)", () => {
    const h = makeHeaders({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.9, 10.0.0.5" });
    expect(resolveClientIp(h)).toBe("10.0.0.5");
  });

  it("nimmt bei mehreren x-forwarded-for-Hops den LETZTEN Eintrag (strukturell vom unmittelbaren Proxy angehängt)", () => {
    const h = makeHeaders({ "x-forwarded-for": "1.2.3.4, 10.0.0.5" });
    expect(resolveClientIp(h)).toBe("10.0.0.5");
  });

  it("fällt auf x-real-ip zurück, wenn x-forwarded-for fehlt", () => {
    const h = makeHeaders({ "x-real-ip": "203.0.113.9" });
    expect(resolveClientIp(h)).toBe("203.0.113.9");
  });

  it("liefert 'unknown', wenn beide Header fehlen", () => {
    const h = makeHeaders({});
    expect(resolveClientIp(h)).toBe("unknown");
  });

  it("lässt sich NICHT durch einen client-gefälschten linkesten Eintrag täuschen", () => {
    // Ein Angreifer schickt eine gefälschte "erste" IP mit — sie darf NICHT
    // das Ergebnis sein (das war der ursprüngliche "linkester Eintrag"-Bug).
    const h = makeHeaders({ "x-forwarded-for": "6.6.6.6-fake-attacker-ip, 10.0.0.5" });
    const result = resolveClientIp(h);
    expect(result).not.toBe("6.6.6.6-fake-attacker-ip");
    expect(result).toBe("10.0.0.5");
  });
});

describe("signInWithMagicLink — Rate-Limit-Oracle-Schutz", () => {
  it("gibt bei Rate-Limit-Überschreitung denselben neutralen Erfolgs-Zustand zurück und verschickt KEINE Mail", async () => {
    mockedHeaders.mockResolvedValue(makeHeaders({ "x-real-ip": "203.0.113.9" }) as never);
    mockedAdminClient.mockReturnValue(makeAdmin(false) as never);

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result).toEqual({ status: "ok", email: "crew@example.com" });
    expect(signInWithOtp).not.toHaveBeenCalled();
    // Whitelist-Check darf gar nicht erst laufen — Rate-Limit greift davor.
    expect(mockedAllowed).not.toHaveBeenCalled();
  });

  it("verschickt normal eine Mail, wenn das Rate-Limit nicht überschritten ist", async () => {
    mockedHeaders.mockResolvedValue(makeHeaders({ "x-real-ip": "203.0.113.9" }) as never);
    mockedAdminClient.mockReturnValue(makeAdmin(true) as never);

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result).toEqual({ status: "ok", email: "crew@example.com" });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });
});
