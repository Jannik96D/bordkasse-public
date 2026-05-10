import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright-Konfiguration für End-to-End-Tests.
 *
 * Lokal:
 *   pnpm dev          # in einem Terminal — App läuft auf :3000
 *   pnpm e2e          # in zweitem Terminal — Tests gegen die laufende App
 *
 * In CI (siehe .github/workflows/webapp-ci.yml):
 *   webServer-Block startet die App selbst, wartet bis :3000 antwortet,
 *   führt dann die Tests aus und fährt sie wieder runter.
 */
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone-se",
      use: { ...devices["iPhone SE (3rd gen)"] },
    },
  ],
  // In CI startet Playwright die App selbst. Lokal verlassen wir uns darauf,
  // dass `pnpm dev` schon läuft — sonst dauert jeder Run ewig.
  webServer: process.env.CI
    ? {
        command: "pnpm start",
        port: PORT,
        timeout: 120_000,
        reuseExistingServer: false,
      }
    : undefined,
});
