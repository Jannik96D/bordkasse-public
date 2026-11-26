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
import { loginIntentCookieName, loginIntentValue } from "@/lib/auth/login-intent";

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();
const signOut = vi.fn();
const getUser = vi.fn();
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
    getUser,
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
  getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  createClient.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** POST auf /auth/verify mit Formulardaten und wählbaren Headern. */
function verifyRequest(
  headers: Record<string, string>,
  email: string | null = "crew@example.com",
  extra: { typed?: string } = {},
) {
  const body = new URLSearchParams({ token_hash: "tokenhash123", type: "email" });
  if (email !== null) body.set("email", email);
  if (extra.typed !== undefined) body.set("typed_email", extra.typed);
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

describe("/auth/verify — Login-CSRF: Cookie-Beleg + Fallback „Adresse tippen“", () => {
  /** Header inkl. Login-Intent-Cookie für `cookieFor` (oder ohne Cookie). */
  const headersFor = (cookieFor?: string, cookieValue?: string | null) => ({
    "x-forwarded-host": "bordkasse.example.com",
    "x-forwarded-proto": "https",
    origin: APP_ORIGIN,
    ...(cookieFor
      ? { cookie: `${loginIntentCookieName()}=${cookieValue ?? loginIntentValue(cookieFor)}` }
      : {}),
  });
  const noSession = (r: Response & { cookies: { getAll: () => unknown[] } }) => {
    expect(r.cookies.getAll()).toHaveLength(0);
    expect(r.headers.get("set-cookie")).toBeNull();
  };
  const errorCode = (r: Response) =>
    new URL(r.headers.get("location") ?? "").searchParams.get("auth_error");

  it("Cookie passt zum Token-Inhaber → Login, Cookie wird gelöscht", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));

    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`${loginIntentCookieName()}=;`));
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Cookie passt, Plus-Adresse kommt als Leerzeichen an → Login", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { email: "crew+tag@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew+tag@example.com"), "crew tag@example.com"));

    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("Cookie fehlt, aber richtige getippte Adresse → Login (Einladung/Cross-Device)", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null, { typed: " Crew@Example.com " }));

    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Cookie fehlt + falsche/fremde getippte Adresse (Angreifer-Link) → keine Session", async () => {
    // Token gehört dem Angreifer; das Opfer tippt seine eigene Adresse.
    verifyOtp.mockResolvedValue({ data: { user: { email: "angreifer@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null, { typed: "opfer@example.com" }));

    noSession(response);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("Cookie fehlt + nur URL-Hinweis (gefälscht auf Angreiferadresse) → keine Session", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { email: "angreifer@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), "angreifer@example.com"));

    noSession(response);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("Cookie einer ANDEREN Adresse (Opfer-Cookie, Angreifer-Token) → Abweisung", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { email: "angreifer@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    // Angreifer setzt den Hinweis auf SEINE Adresse, das Opfer trägt nur sein eigenes Cookie.
    const response = await POST(verifyRequest(headersFor("opfer@example.com"), "angreifer@example.com"));

    noSession(response);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("Cookie passt zum Hinweis, aber Token-Inhaber ist ein anderer → Abweisung (Angreifer-Link)", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { email: "angreifer@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("opfer@example.com"), "opfer@example.com"));

    noSession(response);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("fehlender Hinweis ohne Cookie und ohne getippte Adresse → keine Session", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null));

    noSession(response);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("Token-Inhaber ohne E-Mail → sauber abgewiesen (kein 500, keine Cookies)", async () => {
    verifyOtp.mockResolvedValue({ data: { user: {} }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));

    expect(response.status).toBe(303);
    noSession(response);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("bestehende Session einer anderen Person → abgelehnt, Token NICHT eingelöst", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "andere@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));

    expect(verifyOtp).not.toHaveBeenCalled();
    noSession(response);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("toast")).toBe("login-session-exists");
  });

  it("bestehende Session derselben Person → erneuter Login ist erlaubt", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "Crew@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));

    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("Cookie-Name ist in Production __Host-präfixiert und wird so gelesen/gelöscht", async () => {
    expect(loginIntentCookieName()).toBe("__Host-bk_login_intent");
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/__Host-bk_login_intent=;/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("abgelaufenes Cookie (älter als 60 Min) zählt nicht als Beleg", async () => {
    const old = loginIntentValue("crew@example.com", Date.now() - 61 * 60 * 1000);
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com", old)));

    noSession(response);
    expect(errorCode(response)).toBe("email_mismatch");
  });

  it("verschiedene getippte und Hinweis-Adresse → Abbruch VOR dem Einlösen, Token bleibt gültig", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(
      verifyRequest(headersFor(), "angreifer@example.com", { typed: "opfer@example.com" }),
    );

    expect(verifyOtp).not.toHaveBeenCalled();
    noSession(response);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/auth/confirm");
    expect(location.searchParams.get("typed_error")).toBe("1");
    expect(location.searchParams.get("token_hash")).toBe("tokenhash123");
    // Die (womöglich fremde) Hinweis-Adresse steht nicht in der Adresszeile.
    expect(location.searchParams.has("email")).toBe(false);
    expect(response.headers.get("location")).not.toContain("angreifer");
  });

  it("exotischer Hinweis (&, #, =, %) → KEIN Vorab-Abbruch, Link bleibt benutzbar", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(
      verifyRequest(headersFor(), "a&b#c=d%zz@x.de", { typed: "crew@example.com" }),
    );

    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("getippte Adresse nur mit anderer Schreibweise des Hinweises → kein Vorab-Abbruch", async () => {
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(
      verifyRequest(headersFor(), "Crew@Example.com", { typed: " crew@example.com " }),
    );

    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("bestehende Session ohne E-Mail → kein 500, regulärer Ablauf", async () => {
    getUser.mockResolvedValue({ data: { user: {} }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com")));

    expect(response.status).toBe(303);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("bestehende Session + keinerlei beanspruchte Adresse → abgelehnt ohne Fehler", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "andere@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null));

    expect(response.status).toBe(303);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("nur getippte Adresse (kein Hinweis) wird für den Session-Guard herangezogen", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "crew@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null, { typed: "crew@example.com" }));

    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-secret");
  });

  it("abgelaufener Link im Fallback ohne Cookie hängt KEINE Adresse an /login (die Seite nutzt sie ohne Cookie nicht)", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", message: "expired" } });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null, { typed: "crew@example.com" }));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("auth_error")).toBe("otp_expired");
    expect(location.searchParams.has("email")).toBe(false);
  });

  it("abgelaufener Link mit Cookie einer ANDEREN Adresse hängt den Hinweis nicht an", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", message: "expired" } });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com"), "angreifer@example.com"));

    expect(new URL(response.headers.get("location") ?? "").searchParams.has("email")).toBe(false);
  });

  it("email_mismatch bei bestehender Session → Toast auf / statt verlorener /login-Meldung", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "opfer@example.com" } }, error: null });
    verifyOtp.mockResolvedValue({ data: { user: { email: "angreifer@example.com" } }, error: null });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor(), null, { typed: "opfer@example.com" }));

    noSession(response);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("toast")).toBe("login-email-mismatch");
  });

  it("lässt bei abgelaufenem Link den Resend-Pfad (email an /login) unverändert", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", message: "expired" } });
    const { POST } = await import("@/app/auth/verify/route");
    const response = await POST(verifyRequest(headersFor("crew@example.com"), "crew@example.com"));

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
