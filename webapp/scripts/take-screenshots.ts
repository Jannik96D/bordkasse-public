/**
 * Screenshots für die /about-Seite.
 * Loggt sich als skipper@example.com via Magic-Link (Mailpit) ein
 * und klickt die wichtigsten Screens durch.
 *
 * Voraussetzungen:
 *   - supabase start
 *   - supabase db reset
 *   - psql ... -f supabase/seed_demo.sql
 *   - pnpm dev (Port 3000)
 *
 * Aufruf: pnpm tsx scripts/take-screenshots.ts
 */
import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = "http://localhost:3000";
const MAILPIT_URL = "http://127.0.0.1:54324";
const EMAIL = "skipper@example.com";
const OUT_DIR = resolve(__dirname, "../public/about");

async function fetchMagicLink(): Promise<string> {
  // Mailpit-API: letzte Mail an EMAIL holen
  const url = new URL(`${MAILPIT_URL}/api/v1/search`);
  url.searchParams.set("query", `to:"${EMAIL}"`);
  url.searchParams.set("limit", "1");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const data = (await res.json()) as { messages: Array<{ ID: string }> };
  const id = data.messages[0]?.ID;
  if (!id) throw new Error("Keine Magic-Link-Mail in Mailpit gefunden");

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
  const path = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  ✔ ${name}.png`);
}

async function waitForLoad(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Server Components rendern asynchron — kurze visuelle Pause
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
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

  console.log("→ Magic-Link anfordern");
  await clearMailpit();
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.getByRole("button", { name: /Magic-Link anfordern/i }).click();
  await page.waitForTimeout(2000);

  const magicLink = await fetchMagicLink();
  console.log(`  ↳ Magic-Link: ${magicLink.slice(0, 80)}…`);
  await page.goto(magicLink);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  console.log(`  ↳ Nach Magic-Link: ${page.url()}`);

  // Workaround: site_url ist auf 127.0.0.1:3000/ statt /auth/callback gesetzt.
  // Wir holen uns den ?code= aus der URL und rufen /auth/callback selbst auf.
  const landed = new URL(page.url());
  const code = landed.searchParams.get("code");
  if (code) {
    await page.goto(`${BASE_URL}/auth/callback?code=${code}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    console.log(`  ↳ Nach Callback: ${page.url()}`);
  }

  // Sollte jetzt auf "/" als eingeloggter Skipper sein
  await page.goto(BASE_URL);
  await waitForLoad(page);
  console.log(`  ↳ Auf "/" gelandet bei: ${page.url()}`);
  const headingText = await page.locator("h1").first().textContent().catch(() => "");
  console.log(`  ↳ H1 = "${headingText}"`);

  console.log("→ Trips-Übersicht (eingeloggt)");
  await shot(page, "03-trips");

  // Trip-ID aus dem Link in der Liste holen (UUID-Pattern, ignoriert /trips/new)
  const tripHrefs = await page.locator('a[href^="/trips/"]').evaluateAll((els) =>
    els
      .map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
      .filter((h) => /^\/trips\/[0-9a-f-]{36}$/.test(h)),
  );
  const tripHref = tripHrefs[0];
  if (!tripHref) throw new Error(`Kein Trip-UUID-Link gefunden. Gefunden: ${JSON.stringify(tripHrefs)}`);
  const tripId = tripHref.replace("/trips/", "");
  console.log(`  ↳ Trip-ID: ${tripId}`);

  console.log("→ Trip-Übersicht");
  await page.goto(`${BASE_URL}/trips/${tripId}`);
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
