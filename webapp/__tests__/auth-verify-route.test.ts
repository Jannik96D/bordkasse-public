/**
 * Regressionstest für die REIHENFOLGE in den Auth-Route-Handlern.
 *
 * Der eigentliche Schutz ist nicht `requestMayRedeemToken` selbst, sondern die
 * Tatsache, dass es VOR `verifyOtp` / `exchangeCodeForSession` läuft. Wandert
 * der Aufruf beim Refactoring hinter das Einlösen, ist der Single-Use-Token
 * verbraucht, obwohl der Request abgewiesen wird — genau der Fehler, den der
 * Guard verhindern soll. Bisher hielt diese Zusicherung nur ein Kommentar.
 *
 * Geprüft wird deshalb: bei nicht freigegebenem Host wird der Supabase-Client
 * überhaupt nicht erzeugt (kein Netz-Call, kein Einlösen).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();
const signOut = vi.fn();
// Wie der echte Cookie-Adapter: ein erfolgreiches verifyOtp schreibt die
// Session-Cookies direkt auf die übergebene Response.
const SESSION_USER_EMAIL = "crew@example.com";
const createClient = vi.fn(async (response?: { cookies: { set: (n: string, v: string) => void } }) => ({
  auth: {
    verifyOtp: async (args: unknown) => {
      const result = await verifyOtp(args);
      if (!result.error) response?.cookies.set("sb-access-token", "session-secret");
      return result;
    },
    exchangeCodeForSession,
    signOut,
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}));

const APP_ORIGIN = "https://bordkasse.example.com";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", APP_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  verifyOtp
    .mockReset()
    .mockResolvedValue({ data: { user: { email: SESSION_USER_EMAIL } }, error: null });
  signOut.mockReset().mockResolvedValue({ error: null });
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  createClient.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** POST auf /auth/verify mit Formulardaten und wählbaren Headern. */
function verifyRequest(headers: Record<string, string>, email: string | null = "crew@example.com") {
  const body = new URLSearchParams({ token_hash: "tokenhash123", type: "email" });
  if (email !== null) body.set("email", email);
  return new NextRequest("http://0.0.0.0:3000/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("/auth/verify — Guard läuft vor dem Einlösen", () => {
  it("löst den Token bei fremdem Host NICHT ein", async () => {
    const { POST } = await import("@/app/auth/verify/route");

    const response = await POST(
      verifyRequest({ "x-forwarded-host": "fremde-domain.example", "x-forwarded-proto": "https" }),
    );

    expect(createClient).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("auth_error")).toBe("untrusted_host");
    // Redirect zeigt auf die konfigurierte Domain, nicht auf den fremden Host.
    // Bewusst `origin` vergleichen statt `startsWith`: Letzteres würde auch
    // ein `https://bordkasse.example.com.evil.com` passieren lassen.
    expect(location.origin).toBe(APP_ORIGIN);
  });

  it("löst den Token bei Cross-Origin-POST NICHT ein (Login-CSRF)", async () => {
    const { POST } = await import("@/app/auth/verify/route");

    await POST(
      verifyRequest({
        "x-forwarded-host": "bordkasse.example.com",
        "x-forwarded-proto": "https",
        origin: "https://evil.com",
      }),
    );

    expect(createClient).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("löst den Token beim regulären Request ein (Positiv-Kontrolle)", async () => {
    const { POST } = await import("@/app/auth/verify/route");

    await POST(
      verifyRequest({
        "x-forwarded-host": "bordkasse.example.com",
        "x-forwarded-proto": "https",
        origin: APP_ORIGIN,
      }),
    );

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "tokenhash123", type: "email" });
  });
});

describe("/auth/verify — Login-CSRF: Link muss zur angezeigten Adresse passen", () => {
  const okHeaders = {
    "x-forwarded-host": "bordkasse.example.com",
    "x-forwarded-proto": "https",
    origin: APP_ORIGIN,
  };

  it("setzt bei passender Adresse die Session (case-insensitiv, getrimmt)", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(okHeaders, "  Crew@Example.COM "));

    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("setzt bei abweichender Adresse KEINE Session-Cookies und meldet ab", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(okHeaders, "opfer@example.com"));

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.cookies.getAll()).toHaveLength(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("auth_error")).toBe("email_mismatch");
    // Die (fremde) Adresse wird nicht an /login weitergereicht.
    expect(location.searchParams.get("email")).toBeNull();
  });

  it("setzt bei fehlendem email-Parameter KEINE Session", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(okHeaders, null));

    expect(response.cookies.getAll()).toHaveLength(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
      "email_mismatch",
    );
  });

  it("lässt bei abgelaufenem Link den Resend-Pfad (email an /login) unverändert", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", message: "expired" } });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(okHeaders, "crew@example.com"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("otp_expired");
    expect(location.searchParams.get("email")).toBe("crew@example.com");
    expect(response.cookies.getAll()).toHaveLength(0);
  });
});

describe("/auth/callback — Guard läuft vor dem Code-Tausch", () => {
  function callbackRequest(headers: Record<string, string>) {
    return new NextRequest("http://0.0.0.0:3000/auth/callback?code=abc123", { headers });
  }

  it("tauscht den Code bei fremdem Host NICHT ein", async () => {
    const { GET } = await import("@/app/auth/callback/route");

    const response = await GET(
      callbackRequest({ "x-forwarded-host": "fremde-domain.example", "x-forwarded-proto": "https" }),
    );

    expect(createClient).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("auth_error")).toBe("untrusted_host");
  });

  it("tauscht den Code beim regulären Request ein (Positiv-Kontrolle)", async () => {
    const { GET } = await import("@/app/auth/callback/route");

    await GET(
      callbackRequest({ "x-forwarded-host": "bordkasse.example.com", "x-forwarded-proto": "https" }),
    );

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
  });
});
