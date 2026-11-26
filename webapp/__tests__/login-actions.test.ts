// Login-Rate-Limit (PR 8): IP-Ermittlung + Oracle-Schutz bei Überschreitung.
//
// Folgt dem Mock-Muster aus transaction-actions.test.ts: "server-only" +
// Supabase-/Next-Abhängigkeiten werden gemockt, sodass die Server-Action ohne
// echte DB/Request-Kontext getestet werden kann.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/cookieless", () => ({ createCookielessClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ isEmailAllowedToSignIn: vi.fn() }));
vi.mock("@/lib/auth/origin", () => ({ resolveOrigin: vi.fn(() => "https://bordkasse.dieter.ms") }));

import { signInWithMagicLink, type LoginState } from "@/app/login/actions";
import { resolveClientIp } from "@/lib/auth/client-ip";
import { headers } from "next/headers";
import { createCookielessClient } from "@/lib/supabase/cookieless";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEmailAllowedToSignIn } from "@/lib/auth/authz";

const mockedHeaders = vi.mocked(headers);
const mockedCreateClient = vi.mocked(createCookielessClient);
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

// Auth-Admin-API (ensureAuthUser, Slice 1). Pro Test über beforeEach
// zurückgesetzt; Standard = Konto wird frisch angelegt.
const createUser = vi.fn();
const listUsers = vi.fn();
const updateUserById = vi.fn();
const deleteUser = vi.fn();
/** persons/persons_private-Antworten für die Verknüpfungsprüfung in ensureAuthUser. */
let linkedPerson: { id: string } | null = null;
let linkedEmail: string | null = null;

/** Reihenfolge der Aufrufe über alle Mocks hinweg (Konto VOR OTP). */
const callOrder: string[] = [];

/** Admin-Client-Mock, dessen `bump_login_rate_limit`-RPC `allowed` liefert. */
function makeAdmin(allowed: boolean) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: allowed, error: null }),
    auth: { admin: { createUser, listUsers, updateUserById, deleteUser } },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () =>
        table === "persons"
          ? { data: linkedPerson, error: null }
          : { data: linkedEmail ? { email: linkedEmail } : null, error: null };
      return b;
    },
  };
}

const signInWithOtp = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockedCreateClient.mockReturnValue({ auth: { signInWithOtp } } as never);
  signInWithOtp.mockImplementation(async () => {
    callOrder.push("otp");
    return { error: null };
  });
  createUser.mockImplementation(async () => {
    callOrder.push("createUser");
    return { data: { user: { id: "u-neu" } }, error: null };
  });
  listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  deleteUser.mockResolvedValue({ data: {}, error: null });
  linkedPerson = null;
  linkedEmail = null;
  updateUserById.mockImplementation(async () => {
    callOrder.push("updateUserById");
    return { data: { user: { id: "u-alt" } }, error: null };
  });
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
    // Slice 1: auch kein Konto anlegen.
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("loggt bei Rate-Limit-Treffer die E-Mail nur als gekürzten HMAC, nie im Klartext", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    mockedHeaders.mockResolvedValue(makeHeaders({ "x-real-ip": "203.0.113.9" }) as never);
    mockedAdminClient.mockReturnValue(makeAdmin(false) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await signInWithMagicLink(IDLE, makeFormData("Crew@Example.com"));

    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged.toLowerCase()).not.toContain("crew@example.com");
    // HMAC mit serverseitigem Secret, nicht bloßer SHA-256 (Wörterbuch).
    const expected = createHmac("sha256", "test-service-key").update("crew@example.com").digest("hex").slice(0, 12);
    const plain = createHash("sha256").update("crew@example.com").digest("hex").slice(0, 12);
    expect(logged).toContain(`"emailHash":"${expected}"`);
    expect(logged).not.toContain(plain);
    // Die IP bleibt sichtbar (Prüfung der IP-Ermittlung, Sanierungsplan PR 8).
    expect(logged).toContain("203.0.113.9");
    vi.unstubAllEnvs();
  });

  it("verschickt normal eine Mail, wenn das Rate-Limit nicht überschritten ist", async () => {
    mockedHeaders.mockResolvedValue(makeHeaders({ "x-real-ip": "203.0.113.9" }) as never);
    mockedAdminClient.mockReturnValue(makeAdmin(true) as never);

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result).toEqual({ status: "ok", email: "crew@example.com" });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });
});

describe("signInWithMagicLink — Konto serverseitig mit Anker (Sicherheitsrunde 2026-11, Slice 1)", () => {
  beforeEach(() => {
    mockedHeaders.mockResolvedValue(makeHeaders({ "x-real-ip": "203.0.113.9" }) as never);
    mockedAdminClient.mockReturnValue(makeAdmin(true) as never);
  });

  it("legt das Konto bestätigt + mit Anker an, BEVOR der OTP verschickt wird", async () => {
    const result = await signInWithMagicLink(IDLE, makeFormData("Crew@Example.com"));

    expect(result).toEqual({ status: "ok", email: "Crew@Example.com" });
    expect(createUser).toHaveBeenCalledWith({
      email: "crew@example.com",
      email_confirm: true,
      app_metadata: { bordkasse_email: "crew@example.com" },
    });
    expect(callOrder).toEqual(["createUser", "otp"]);
  });

  it("verschickt den OTP mit shouldCreateUser: false über den cookielosen Client", async () => {
    await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(mockedCreateClient).toHaveBeenCalled();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    const arg = signInWithOtp.mock.calls[0][0] as { options: { shouldCreateUser?: boolean } };
    expect(arg.options.shouldCreateUser).toBe(false);
  });

  it("email_exists → verknüpftes Altkonto ohne Anker wird bestätigt + geankert, dann OTP", async () => {
    createUser.mockImplementation(async () => {
      callOrder.push("createUser");
      return { data: { user: null }, error: { code: "email_exists", message: "egal" } };
    });
    listUsers.mockResolvedValue({
      data: {
        users: [
          { id: "u-fremd", email: "andere@example.com", app_metadata: {} },
          { id: "u-alt", email: "CREW@example.com", app_metadata: { provider: "email" }, email_confirmed_at: null },
        ],
      },
      error: null,
    });
    linkedPerson = { id: "p-1" };
    linkedEmail = "crew@example.com";

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result).toEqual({ status: "ok", email: "crew@example.com" });
    expect(updateUserById).toHaveBeenCalledWith("u-alt", {
      email_confirm: true,
      app_metadata: { bordkasse_email: "crew@example.com" },
    });
    expect(callOrder).toEqual(["createUser", "updateUserById", "otp"]);
  });

  it("erkennt email_exists am Code, nicht am Text", async () => {
    // Text sieht nach "existiert" aus, Code ist ein anderer → fail-closed.
    createUser.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", message: "A user with this email address has already been registered" },
    });
    // Ein passendes, verknüpftes Bestandskonto existiert — ein Text-Match
    // würde es ankern und den Link verschicken.
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: "crew@example.com", app_metadata: {} }] },
      error: null,
    });
    linkedPerson = { id: "p-1" };
    linkedEmail = "crew@example.com";

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result.status).toBe("error");
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("anderer Fehler bei createUser → keine Mail, neutrale Fehlermeldung", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "unexpected_failure", message: "x" } });

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result).toEqual({
      status: "error",
      message: "Login-Link konnte nicht versandt werden. Bitte später erneut versuchen.",
    });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("scheitert updateUserById → keine Mail", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "email_exists", message: "x" } });
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: "crew@example.com", app_metadata: {} }] },
      error: null,
    });
    linkedPerson = { id: "p-1" };
    linkedEmail = "crew@example.com";
    updateUserById.mockResolvedValue({ data: { user: null }, error: { code: "unexpected_failure", message: "x" } });

    const result = await signInWithMagicLink(IDLE, makeFormData("crew@example.com"));

    expect(result.status).toBe("error");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("nicht freigeschaltete Adresse → weder Konto noch Mail (Whitelist-Meldung unverändert, D4)", async () => {
    mockedAllowed.mockResolvedValue(false);

    const result = await signInWithMagicLink(IDLE, makeFormData("fremd@example.com"));

    expect(result.status).toBe("error");
    expect(createUser).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
});
