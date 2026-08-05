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
const createClient = vi.fn(async () => ({
  auth: { verifyOtp, exchangeCodeForSession },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}));

const APP_ORIGIN = "https://bordkasse.example.com";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", APP_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  createClient.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** POST auf /auth/verify mit Formulardaten und wählbaren Headern. */
function verifyRequest(headers: Record<string, string>) {
  const body = new URLSearchParams({
    token_hash: "tokenhash123",
    type: "email",
    email: "crew@example.com",
  });
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

    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("auth_error=untrusted_host");
    // Redirect zeigt auf die konfigurierte Domain, nicht auf den fremden Host.
    expect(location.startsWith(APP_ORIGIN)).toBe(true);
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
    expect(response.headers.get("location") ?? "").toContain("auth_error=untrusted_host");
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
