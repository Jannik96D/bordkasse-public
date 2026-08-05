/**
 * Tests für die Origin-Auflösung aus lib/auth/origin.ts: Open-Redirect-Schutz
 * (safeNextPath), Env-Fallback (resolveOrigin/appOrigin), Redirect-Origin
 * hinter dem Reverse-Proxy (resolveRedirectOrigin) und der Token-Schutz
 * (requestMayRedeemToken).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appOrigin,
  requestMayRedeemToken,
  resolveOrigin,
  resolveRedirectOrigin,
  safeNextPath,
} from "@/lib/auth/origin";

// Ein fehlgeschlagenes `expect` wirft — ein Aufräumen am Ende des Test-Bodys
// würde dann übersprungen und NODE_ENV="production" bzw. ein console-Mock
// leckte in alle folgenden Tests der Datei (die dann aus dem falschen Grund
// grün oder rot wären). Deshalb zentral in afterEach.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Setzt Env-Variablen temporär und stellt sie danach wieder her. */
function withEnvVars(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("safeNextPath", () => {
  it("lässt interne, absolute Pfade durch", () => {
    expect(safeNextPath("/trips/123")).toBe("/trips/123");
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/profile?tab=x")).toBe("/profile?tab=x");
  });

  it("weist externe und protokoll-relative URLs ab", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("http://evil.com/path")).toBe("/");
  });

  it("fällt bei leerem/fehlendem Wert auf den Fallback zurück", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("relativ/ohne/slash")).toBe("/");
  });

  it("respektiert einen abweichenden Fallback", () => {
    expect(safeNextPath(null, "/login")).toBe("/login");
    expect(safeNextPath("//evil.com", "/login")).toBe("/login");
  });
});

describe("resolveOrigin — Env-Fallback (SITE_URL || APP_ORIGIN)", () => {
  const withEnv = withEnvVars;

  it("nutzt NEXT_PUBLIC_APP_ORIGIN, wenn NEXT_PUBLIC_SITE_URL fehlt", () => {
    // Genau die Prod-Konstellation, die den Invite-Crash verursachte:
    // SITE_URL nicht gesetzt, aber APP_ORIGIN vorhanden.
    withEnv(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        expect(resolveOrigin(null)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("bevorzugt NEXT_PUBLIC_SITE_URL vor APP_ORIGIN", () => {
    withEnv(
      { NEXT_PUBLIC_SITE_URL: "https://site.example.com", NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com" },
      () => {
        expect(resolveOrigin(null)).toBe("https://site.example.com");
      },
    );
  });

  it("nutzt APP_ORIGIN, wenn SITE_URL ein LEERER STRING ist (Docker-ARG-Fall)", () => {
    // In Docker-Builds (Coolify) wird ein nicht gesetzter ARG beim ENV-Befehl
    // zu "" statt undefined — anders als auf Vercel. `??` würde hier fälschlich
    // den leeren String gewinnen lassen (Fund beim Coolify-Cutover).
    withEnv(
      { NEXT_PUBLIC_SITE_URL: "", NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        expect(resolveOrigin(null)).toBe("https://bordkasse.example.com");
      },
    );
  });
});

describe("appOrigin — absolute Links in Mails", () => {
  it("nutzt APP_ORIGIN, wenn SITE_URL leer ist (Docker-ARG-Fall)", () => {
    // Der Kern des Fundes: mit `??` hätte der leere String gewonnen und alle
    // Mail-Links wären relative, im Mail-Client tote Pfade geworden.
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "", NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        expect(appOrigin()).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("schneidet einen Trailing-Slash ab (sonst doppelte Slashes im Link)", () => {
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com/", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        expect(appOrigin()).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("liefert eine absolute Fallback-URL statt zu werfen, wenn beide Env-Vars fehlen", () => {
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        expect(appOrigin()).toBe("https://bordkasse.dieter.ms");
      },
    );
  });

  it("fällt auch bei einem unparsbaren Wert auf die absolute URL zurück", () => {
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "bordkasse.dieter.ms", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        expect(appOrigin()).toBe("https://bordkasse.dieter.ms");
      },
    );
  });

  it("überspringt ein SITE_URL OHNE SCHEMA und nimmt die gültige APP_ORIGIN", () => {
    // Der realistische Fehlfall: `test -n` im Dockerfile lässt den Wert durch,
    // aber `new URL()` kann ihn nicht parsen. Würde er die zweite (gültige)
    // Variable verdecken, wäre die Allowlist leer und der Login komplett tot.
    withEnvVars(
      {
        NEXT_PUBLIC_SITE_URL: "bordkasse.dieter.ms",
        NEXT_PUBLIC_APP_ORIGIN: "https://echt.example.com",
      },
      () => {
        expect(appOrigin()).toBe("https://echt.example.com");
        expect(resolveOrigin(null)).toBe("https://echt.example.com");
      },
    );
  });
});

describe("resolveRedirectOrigin — Auth-Redirects hinter dem Reverse-Proxy", () => {
  const REQ_URL = "http://0.0.0.0:3000/auth/verify";

  it("nimmt den erlaubten x-forwarded-host, damit Cookie-Host und Redirect-Ziel gleich sind", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          "x-forwarded-proto": "https",
        });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("ignoriert einen nicht erlaubten Host-Header und nutzt die Env (kein Open-Redirect)", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ host: "evil.com" });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("akzeptiert einen erlaubten Origin-Header, wenn keine Host-Header vorliegen", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ origin: "https://bordkasse.example.com" });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("weist einen Forwarded-Host ab, der sich nur im Port unterscheidet", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ "x-forwarded-host": "bordkasse.example.com:8443" });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("wirft NICHT, wenn beide Env-Vars fehlen, und nutzt den Host des Requests", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ host: "eigene-instanz.example" });
        // Der Host des Requests ist die einzige erreichbare Adresse und trägt
        // auch das Session-Cookie. NICHT der Host aus der Request-URL (hinter
        // Traefik das unerreichbare 0.0.0.0:3000) und NICHT die fest
        // verdrahtete Domain dieser Installation (in einem Fork eine fremde).
        //
        // Schema: ohne jeden Proxy-Header ist das der Wert aus der Request-URL
        // (hier http) — bewusst keine https-Annahme, sonst bräche ein reiner
        // Klartext-Betrieb. Läuft ein TLS-Proxy davor, schickt er
        // x-forwarded-proto und der Zweig oben greift ohnehin früher.
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("http://eigene-instanz.example");
      },
    );
  });

  it("nimmt BEIDE Env-Origins in die Allowlist (SITE_URL und APP_ORIGIN)", () => {
    // Die beiden Variablen sollen denselben Wert tragen, erzwungen ist das
    // aber nicht. Stünde nur der Gewinner auf der Allowlist, würde eine
    // veraltete SITE_URL die aktuelle APP_ORIGIN aussperren.
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      {
        NEXT_PUBLIC_SITE_URL: "https://alt.example.com",
        NEXT_PUBLIC_APP_ORIGIN: "https://aktuell.example.com",
      },
      () => {
        const headers = new Headers({ "x-forwarded-host": "aktuell.example.com" });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://aktuell.example.com");
      },
    );
  });

  it("fällt bei LEEREM x-forwarded-host auf den Host-Header zurück", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({ "x-forwarded-host": "", host: "bordkasse.example.com" });
        expect(resolveRedirectOrigin(headers, REQ_URL)).toBe("https://bordkasse.example.com");
      },
    );
  });

  it("nutzt außerhalb von Production den Request-Host OHNE Proxy-Header (Handy über die LAN-IP)", () => {
    // Kein Reverse-Proxy im Spiel: der Browser schickt `host`, aber KEIN
    // x-forwarded-proto. Würde das Schema pauschal auf https defaulten, ginge
    // der Redirect auf https://192.168.x.x:3000 gegen einen Klartext-Server
    // (ERR_SSL_PROTOCOL_ERROR) — und der Token wäre schon verbraucht.
    vi.stubEnv("NODE_ENV", "development");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "http://localhost:3000", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ host: "192.168.1.20:3000" });
        expect(resolveRedirectOrigin(headers, "http://192.168.1.20:3000/auth/verify")).toBe(
          "http://192.168.1.20:3000",
        );
      },
    );
  });

  it("übernimmt hinter einem Proxy das https-Schema aus x-forwarded-proto", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        // Traefik terminiert TLS und spricht intern http — der Redirect muss
        // trotzdem auf https zeigen.
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          "x-forwarded-proto": "https,http",
        });
        expect(resolveRedirectOrigin(headers, "http://0.0.0.0:3000/auth/verify")).toBe(
          "https://bordkasse.example.com",
        );
      },
    );
  });
});

describe("requestMayRedeemToken — Token-Schutz vor dem Einlösen", () => {
  const REQ_URL = "http://0.0.0.0:3000/auth/verify";

  it("erlaubt den Request über die konfigurierte Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          "x-forwarded-proto": "https",
          origin: "https://bordkasse.example.com",
        });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(true);
      },
    );
  });

  it("sperrt NICHT aus, wenn der Proxy kein x-forwarded-proto schickt", () => {
    // Lockout-Falle: ohne x-forwarded-proto leitet forwardedOrigin das Schema
    // aus der internen Request-URL ab (http) — ein Vergleich des VOLLEN Origins
    // gegen eine https-Allowlist würde hier jeden Login der gesamten Crew
    // abweisen. Deshalb vergleicht der Guard nur den Host.
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({ host: "bordkasse.example.com" });
        expect(requestMayRedeemToken(headers, "http://0.0.0.0:3000/auth/verify")).toBe(true);
      },
    );
  });

  it("sperrt NICHT aus, wenn der Origin-Header http statt https trägt", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          origin: "http://bordkasse.example.com",
        });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(true);
      },
    );
  });

  it("blockt `Origin: null` (Sandbox-iframe / data:-URL)", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          origin: "null",
        });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(false);
      },
    );
  });

  it("ignoriert Groß-/Kleinschreibung im Host", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({ "x-forwarded-host": "Bordkasse.Example.COM" });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(true);
      },
    );
  });

  it("blockt bei LEEREM x-forwarded-host nicht versehentlich fail-open", () => {
    // Mit `??` statt `||` wäre host = "" → forwardedOrigin null → die
    // Host-Prüfung wäre stillschweigend ausgeschaltet. Hier muss der fremde
    // Host aus dem Host-Header also weiterhin blocken.
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: "https://bordkasse.example.com" },
      () => {
        const headers = new Headers({ "x-forwarded-host": "", host: "alt.example.com" });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(false);
      },
    );
  });

  it("blockt einen fremden Host, damit der Single-Use-Token nicht verbrennt", () => {
    // Aufruf über eine nicht freigegebene Domain: verifyOtp würde das Cookie
    // dort setzen, der Redirect zeigt aber auf die kanonische Domain → Nutzer
    // ausgeloggt, Token weg, jeder neue Link scheitert identisch.
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ "x-forwarded-host": "alt.example.com" });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(false);
      },
    );
  });

  it("blockt einen Cross-Origin-POST (Login-CSRF)", () => {
    // Angreifer lässt sich einen Link für das EIGENE Konto schicken und postet
    // ihn per Auto-Submit-Formular aus dem Browser des Opfers — das Opfer wäre
    // sonst im Konto des Angreifers eingeloggt.
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          "x-forwarded-proto": "https",
          origin: "https://evil.com",
        });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(false);
      },
    );
  });

  it("verlangt keinen Origin-Header (GET-Linkklick schickt keinen)", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "https://bordkasse.example.com", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({
          "x-forwarded-host": "bordkasse.example.com",
          "x-forwarded-proto": "https",
        });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(true);
      },
    );
  });

  it("blockt nicht, wenn die Env kaputt ist (sonst wäre der Login endgültig tot)", () => {
    vi.stubEnv("NODE_ENV", "production");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: undefined, NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({ host: "irgendwas.example.com", origin: "https://evil.com" });
        expect(requestMayRedeemToken(headers, REQ_URL)).toBe(true);
      },
    );
  });

  it("blockt außerhalb von Production nichts (LAN-IP-Test am Handy)", () => {
    vi.stubEnv("NODE_ENV", "development");
    withEnvVars(
      { NEXT_PUBLIC_SITE_URL: "http://localhost:3000", NEXT_PUBLIC_APP_ORIGIN: undefined },
      () => {
        const headers = new Headers({
          host: "192.168.1.20:3000",
          origin: "http://192.168.1.20:3000",
        });
        expect(requestMayRedeemToken(headers, "http://192.168.1.20:3000/auth/verify")).toBe(true);
      },
    );
  });
});
