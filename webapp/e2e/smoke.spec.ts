import { expect, test } from "@playwright/test";

/**
 * Auth-freie Smoke-Tests:
 *   - öffentliche Routen liefern HTTP 200
 *   - Login-Page rendert das Logo + den Magic-Link-Button
 *   - private Routen redirecten Nicht-Eingeloggte zur Login-Seite
 *   - robots.txt sperrt alle Crawler
 *   - <meta name="robots" content="noindex,…"> ist gesetzt
 */

test.describe("öffentliche Routen", () => {
  test("Welcome-Screen rendert für nicht-eingeloggte User", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Bordkasse" })).toBeVisible();
    await expect(page.getByText("Unsere Bordkasse für gemeinsame Törns")).toBeVisible();
    await expect(page.getByRole("link", { name: "Anmelden" })).toBeVisible();
    // Logo sollte als <img alt="Bordkasse"> im Header sein
    await expect(page.locator('img[alt="Bordkasse"]').first()).toBeVisible();
  });

  test("/login zeigt das Magic-Link-Formular", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/E-Mail/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Magic-Link anfordern/i })).toBeVisible();
  });

  test("/datenschutz lädt", async ({ page }) => {
    const response = await page.goto("/datenschutz");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: /Datenschutzerklärung/i })).toBeVisible();
  });
});

test.describe("Crawler-Schutz", () => {
  test("robots.txt sperrt alle User-Agents", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /");
  });

  test("HTML enthält noindex-Meta-Tag", async ({ page }) => {
    await page.goto("/login");
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots).toMatch(/noindex/);
    expect(robots).toMatch(/nofollow/);
  });
});

test.describe("Auth-Schutz", () => {
  test("/profile redirectet Nicht-Eingeloggte zur Login-Page", async ({ page }) => {
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login/);
  });

  test("/trips/new redirectet Nicht-Eingeloggte zur Login-Page", async ({ page }) => {
    await page.goto("/trips/new");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Security-Header", () => {
  test("HSTS, X-Frame-Options, CSP, Referrer-Policy sind gesetzt", async ({ request }) => {
    const response = await request.get("/login");
    const headers = response.headers();
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("supabase.co");
  });
});
