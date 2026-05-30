/**
 * Screenshots für die /about-Seite.
 * Loggt sich als skipper@example.com via Magic-Link (Mailpit) ein
 * und klickt die wichtigsten Screens durch.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RUNBOOK — erprobter, stabiler Weg (gegen Production-Server, NICHT Dev!)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WARUM Production-Server statt `pnpm dev`:
 *   Turbopack-Dev kompiliert Routen erst beim ersten Aufruf (lazy). Playwright
 *   trifft die Route bevor sie kompiliert ist → 30s-`load`-Timeout, und unter
 *   gleichzeitiger Last (frisch gestartetes colima+supabase+dev) kann der Mac
 *   einfrieren. `next start` serviert vorkompilierte Seiten → CPU-arm, sofort,
 *   keine Timeouts. Das ist der Weg, der zuverlässig durchläuft.
 *
 * REGELN (so vermeide ich Hänger/Absturz):
 *   1. Schritte 1–4 als JE EIGENES, abgeschlossenes Kommando ausführen
 *      (nicht fusionieren) — colima, supabase, seed, build sind je eine
 *      bounded CPU-Spitze, danach wieder ruhig.
 *   2. NUR Schritt 5 fusionieren (Server-Start + Vorwärmen + Shoot in einem
 *      Bash-Kommando), weil der Prod-Server leicht ist UND als Kind-Prozess
 *      des Shoot-Kommandos leben muss (Background-Server überlebt Turns nicht).
 *   3. KEIN Background-Polling-Loop über mehrere Turns, KEIN `|| echo` das
 *      Fehler maskiert, KEIN Retry-Loop. Bei Fehler: stoppen + Log berichten.
 *   4. Code-Auslieferung (commit/push) IMMER von der Screenshot-Erzeugung
 *      entkoppeln — Screenshots dürfen nie das Pushen von grünem Code blocken.
 *
 * SCHRITTE:
 *   1) colima start                 # Docker-VM; verify: `docker info`
 *   2) supabase start               # + blockieren bis API 200:
 *        for i in $(seq 1 50); do curl -sf http://127.0.0.1:54321/rest/v1/ -o /dev/null && break || sleep 3; done
 *   3) ./scripts/seed-demo.sh       # DB reset + Auth-User via Admin-API + seed_demo.sql
 *   4) pnpm build                   # Production-Build (einmalige Spitze)
 *   5) Server + Vorwärmen + Shoot in EINEM Kommando:
 *        pnpm start >/tmp/start.log 2>&1 &
 *        SRV=$!
 *        for i in $(seq 1 20); do curl -sf http://localhost:3000/ -o /dev/null && break || sleep 3; done
 *        for r in / /login /about; do curl -sf "http://localhost:3000$r" -o /dev/null; done   # vorwärmen
 *        npx tsx scripts/take-screenshots.ts; RC=$?
 *        kill $SRV
 *
 * Hinweise:
 *   - Login läuft über Mailpit (lokaler Magic-Link); seed-demo.sh legt
 *     Anna (skipper@) + Clara (clara@) via Admin-API an und verknüpft
 *     persons.auth_user_id (direkte auth.users-INSERTs sind unzuverlässig).
 *   - `public/about/00-about-preview.webp` ist gitignored (Meta-Vorschau).
 *   - 18 WebP-Dateien werden geschrieben; rc=0 + „Alle Screenshots … abgelegt".
 */
import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const BASE_URL = "http://localhost:3000";
const MAILPIT_URL = "http://127.0.0.1:54324";
const SKIPPER_EMAIL = "skipper@example.com";   // Anna (Skipper + Admin)
const CREW_EMAIL = "clara@example.com";        // Clara (reguläres Crew-Member)
const OUT_DIR = resolve(__dirname, "../public/about");

async function fetchMagicLink(email: string): Promise<string> {
  // Mailpit-API: letzte Mail an die angegebene Adresse holen
  const url = new URL(`${MAILPIT_URL}/api/v1/search`);
  url.searchParams.set("query", `to:"${email}"`);
  url.searchParams.set("limit", "1");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const data = (await res.json()) as { messages: Array<{ ID: string }> };
  const id = data.messages[0]?.ID;
  if (!id) throw new Error(`Keine Magic-Link-Mail in Mailpit gefunden (to: ${email})`);

  const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  const msg = (await msgRes.json()) as { Text?: string; HTML?: string };
  const body = msg.HTML ?? msg.Text ?? "";

  // Link sieht aus wie: http://localhost:3000/auth/callback?code=…
  const match = body.match(/https?:\/\/[^\s"<>]+\/auth\/callback\?[^\s"<>]+/);
  if (!match) {
    // Supabase rendert das manchmal als verify-URL → durchnavigieren tut der Browser
    const v = body.match(/https?:\/\/[^\s"<>]+\/auth\/v1\/verify\?[^\s"<>]+/);
    if (!v) throw new Error("Kein Magic-Link in Mail gefunden");
    return decodeEntities(v[0]);
  }
  return decodeEntities(match[0]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function clearMailpit() {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
}

async function shot(page: Page, name: string) {
  // Playwright kann nur PNG/JPEG; wir nehmen den PNG-Buffer und schreiben
  // ihn als WebP raus (~65 % kleiner, von der /about-Seite referenziert).
  const buf = await page.screenshot({ fullPage: false });
  const path = resolve(OUT_DIR, `${name}.webp`);
  await sharp(buf).webp({ quality: 80, effort: 6 }).toFile(path);
  console.log(`  ✔ ${name}.webp`);
}

async function hideDevArtifacts(page: Page) {
  // Next.js DevTools-Indicator + Mailpit-Hinweis erscheinen nur in
  // `pnpm dev`, nicht in Production — fürs Screenshot raus.
  await page.addStyleTag({
    content: `
      nextjs-portal,
      [data-nextjs-dev-tools-button],
      [data-next-mark],
      #__next-build-watcher,
      #__next-prerender-indicator,
      [data-nextjs-toast],
      [data-nextjs-dialog-overlay] { display: none !important; }
    `,
  }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll("p, a").forEach((el) => {
      if (el.textContent?.includes("Mailpit")) {
        const p = el.closest("p");
        if (p) (p as HTMLElement).style.display = "none";
      }
    });
  }).catch(() => {});
}

async function waitForLoad(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Server Components rendern asynchron — kurze visuelle Pause
  await page.waitForTimeout(400);
  await hideDevArtifacts(page);
  await page.waitForTimeout(200);
}

/**
 * Komplett-Login per Magic-Link für eine beliebige E-Mail-Adresse.
 * - klickt sich durchs /login-Formular,
 * - holt den frischen Link aus Mailpit (vorher leeren),
 * - extrahiert ggf. den ?code= und ruft /auth/callback explizit auf
 *   (Workaround: lokale site_url ist 127.0.0.1:3000/ statt /auth/callback),
 * - landet final auf "/" als eingeloggter User.
 */
async function loginAs(page: Page, email: string) {
  console.log(`→ Login als ${email}`);
  await clearMailpit();
  await page.goto(`${BASE_URL}/login`);
  await waitForLoad(page);
  await page.locator('input[type="email"]').fill(email);
  await page.getByRole("button", { name: /Magic-Link anfordern/i }).click();
  await page.waitForTimeout(2000);

  const magicLink = await fetchMagicLink(email);
  console.log(`  ↳ Magic-Link: ${magicLink.slice(0, 80)}…`);
  await page.goto(magicLink);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  const landed = new URL(page.url());
  const code = landed.searchParams.get("code");
  if (code) {
    await page.goto(`${BASE_URL}/auth/callback?code=${code}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }

  await page.goto(BASE_URL);
  await waitForLoad(page);
  const heading = await page.locator("h1").first().textContent().catch(() => "");
  console.log(`  ↳ Eingeloggt als ${email}, H1 = "${heading}"`);
}

/** Logout über Profil-Seite — danach ist die Session sicher gekappt. */
async function logout(page: Page, context: { clearCookies: () => Promise<void> }) {
  // Schnellster Weg: alle Cookies wegwerfen. Supabase-SSR-Cookies + sb-*-auth-token
  // werden damit ungültig, beim nächsten Request wirft der Server uns auf /login.
  await context.clearCookies();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // --lang=de-DE ist nötig, damit native <input type="date"> im deutschen
  // DD.MM.YYYY-Format rendern. Die `locale`-Option in newContext steuert nur
  // navigator.language + Accept-Language, nicht den Date-Picker-Formatter.
  const browser = await chromium.launch({ args: ["--lang=de-DE"] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();

  console.log("→ Welcome-Screen (ausgeloggt)");
  await page.goto(BASE_URL);
  await waitForLoad(page);
  await shot(page, "01-welcome");

  console.log("→ Login-Formular");
  await page.goto(`${BASE_URL}/login`);
  await waitForLoad(page);
  await shot(page, "02-login");

  await loginAs(page, SKIPPER_EMAIL);

  console.log("→ Trips-Übersicht (eingeloggt)");
  await shot(page, "03-trips");

  // Aus der Trip-Liste die beiden Demo-Trips per Namen heraussuchen:
  // - „Pfingst-Törn Ostsee 2026" → Trip 1 für Screenshots 04–14
  // - „Bareboat-Charter Sommer 2027" → Trip 2 für 15–17 (Anzahlungen)
  const tripsByName = await page.locator('a[href^="/trips/"]').evaluateAll((els) =>
    els
      .map((el) => ({
        href: (el as HTMLAnchorElement).getAttribute("href") ?? "",
        text: el.textContent ?? "",
      }))
      .filter((t) => /^\/trips\/[0-9a-f-]{36}$/.test(t.href)),
  );
  const findTripId = (needle: string): string => {
    const hit = tripsByName.find((t) => t.text.includes(needle));
    if (!hit) {
      throw new Error(
        `Trip „${needle}" nicht in Liste. Gefunden: ${JSON.stringify(tripsByName.map((t) => t.text.trim().slice(0, 40)))}`,
      );
    }
    return hit.href.replace("/trips/", "");
  };
  const tripId = findTripId("Pfingst-Törn");
  const tripCharterId = findTripId("Bareboat-Charter");
  console.log(`  ↳ Pfingst-Törn: ${tripId}`);
  console.log(`  ↳ Bareboat-Charter: ${tripCharterId}`);

  // Trip-Übersicht bewusst vom Bareboat-Charter (Zukunft, läuft noch nicht):
  // In der About-Flow-Reihenfolge steht die Übersicht früh (direkt nach
  // „Trip anlegen"), da wäre der „Törn vorbei — Abrechnung verschicken"-Banner
  // des bereits beendeten Pfingst-Törns verfrüht. Der Settlement-/Abrechnungs-
  // Banner wird stattdessen im Schulden-Screenshot (08) gezeigt, der in der
  // Abrechnungs-Phase sitzt.
  console.log("→ Trip-Übersicht (Bareboat — Törn läuft noch)");
  await page.goto(`${BASE_URL}/trips/${tripCharterId}`);
  await waitForLoad(page);
  await shot(page, "04-trip-overview");

  console.log("→ Buchungs-Liste");
  await page.goto(`${BASE_URL}/trips/${tripId}/transactions`);
  await waitForLoad(page);
  await shot(page, "05-buchungen");

  console.log("→ Neue Buchung (Aufteilungslogiken)");
  await page.goto(`${BASE_URL}/trips/${tripId}/transactions/new`);
  await waitForLoad(page);
  // Beispiel-Daten in das Formular eintippen
  await page.locator('input[name="description"]').fill("Lebensmittel Albert Heijn").catch(() => {});
  await page.locator('input[name="amount"]').fill("64,30").catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, "06-buchung-neu");

  console.log("→ Bilanz");
  await page.goto(`${BASE_URL}/trips/${tripId}/balance`);
  await waitForLoad(page);
  await shot(page, "07-bilanz");

  console.log("→ Schulden");
  await page.goto(`${BASE_URL}/trips/${tripId}/debts`);
  await waitForLoad(page);
  await shot(page, "08-schulden");

  console.log("→ Statistik");
  await page.goto(`${BASE_URL}/trips/${tripId}/stats`);
  await waitForLoad(page);
  await shot(page, "09-statistik");

  console.log("→ Crew-Verwaltung (Settings)");
  await page.goto(`${BASE_URL}/trips/${tripId}/settings`);
  await waitForLoad(page);
  await shot(page, "10-crew");

  console.log("→ Kategorien (Settings — nach unten gescrollt)");
  // gleiche Seite, Kategorien sind weiter unten
  await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll("h2, h3")).find((el) =>
      el.textContent?.toLowerCase().includes("kategor"),
    );
    h?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await shot(page, "11-kategorien");

  console.log("→ Gutschrift");
  await page.goto(`${BASE_URL}/trips/${tripId}/transactions/new`);
  await waitForLoad(page);
  // Segmented Control: zweiter Button = Gutschrift
  await page.getByRole("button", { name: "Gutschrift", exact: true }).click();
  await page.waitForTimeout(400);
  await shot(page, "12-gutschrift");

  console.log("→ Offline-Banner");
  await page.goto(`${BASE_URL}/trips/${tripId}/transactions`);
  await waitForLoad(page);
  // Browser-offline-Mode aktivieren
  await context.setOffline(true);
  // navigator.onLine-Event triggern
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForTimeout(1500);
  await shot(page, "13-offline");
  await context.setOffline(false);

  console.log("→ DSGVO-Auszug (Datenschutz, Abschnitt 5)");
  await page.goto(`${BASE_URL}/datenschutz`);
  await waitForLoad(page);
  await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll("h2")).find((el) =>
      el.textContent?.includes("Speicherdauer"),
    );
    h?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await shot(page, "14-dsgvo");

  // ────────────────────────────────────────────────────────────────────
  // Anzahlungs-Modul (Trip 2 — Bareboat-Charter)
  //   15-anzahlung-setup    Wizard Step 2 (Tranchen-Editor)
  //   16-anzahlung-matrix   Matrix mit Charter-Banner + Vorstrecker-Zeile
  //   17-anzahlung-crew-self  Crew-Self-View (als Clara, nicht-Skipper)
  // ────────────────────────────────────────────────────────────────────

  console.log("→ Anzahlungs-Wizard (Step 1 mit Kojen + Vorstrecker)");
  await page.goto(`${BASE_URL}/trips/${tripCharterId}/prepayments/setup`);
  await waitForLoad(page);
  // Wir zeigen Step 1 mit Kojen-Editor + Vorstrecker-Auswahl. Step 2
  // wäre der Tranchen-Editor, lässt sich aber nicht direkt anspringen
  // (nur via setState nach erfolgreichem Server-Save) — und ein Click
  // hier sendet sonst das ganze Plan-Payload nochmal an den Server. Step 1
  // erklärt das Konzept ohnehin am besten: Aufteilungs-Methode, Kojen,
  // Vorstrecker, Wero-ID. Wir scrollen zur Kojen-Sektion, weil das der
  // visuell interessanteste Teil ist.
  await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll("label, h2, h3")).find((el) =>
      (el.textContent ?? "").toLowerCase().includes("kojen"),
    );
    h?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await shot(page, "15-anzahlung-setup");

  console.log("→ Anzahlungs-Matrix (Charter-Banner + Pending + Vorstrecker)");
  await page.goto(`${BASE_URL}/trips/${tripCharterId}/prepayments`);
  await waitForLoad(page);
  // Etwas nach unten scrollen, damit der Charter-Reminder-Banner + ein
  // Stück Matrix sichtbar sind (volle Matrix passt nicht ins Mobile-Viewport).
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot(page, "16-anzahlung-matrix");

  console.log("→ Crew-Self-View — Re-Login als Clara");
  await logout(page, context);
  await loginAs(page, CREW_EMAIL);
  await page.goto(`${BASE_URL}/trips/${tripCharterId}/prepayments`);
  await waitForLoad(page);
  await shot(page, "17-anzahlung-crew-self");

  // Zurück zum Skipper, damit der finale About-Preview-Screenshot vom
  // eingeloggten Standardzustand kommt.
  await logout(page, context);
  await loginAs(page, SKIPPER_EMAIL);

  console.log("→ /about-Seite selbst (Preview)");
  await page.goto(`${BASE_URL}/about`);
  await waitForLoad(page);
  await shot(page, "00-about-preview");

  await browser.close();
  console.log("\n✓ Alle Screenshots in webapp/public/about/ abgelegt.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
