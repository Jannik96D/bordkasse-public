/**
 * Lighthouse-Accessibility-Audit gegen eingeloggte Routen.
 *
 * Loggt sich als skipper@example.com per Magic-Link (Mailpit) ein,
 * extrahiert die Supabase-Session-Cookies und fährt anschließend
 * `npx lighthouse@latest --only-categories=accessibility` über alle
 * relevanten Trip-Routen. Cookies werden via `--extra-headers` an die
 * SSR-Requests gehängt — Lighthouse rendert dadurch die Seiten im
 * eingeloggten Zustand.
 *
 * Voraussetzungen:
 *   - supabase start            (lokales Supabase inkl. Mailpit:54324)
 *   - supabase db reset + psql -f supabase/seed_demo.sql
 *   - pnpm dev                  (Next.js auf :3000)
 *
 * Aufruf: pnpm tsx scripts/lighthouse-authenticated.ts
 *
 * Ergebnis:
 *   - Konsolen-Zusammenfassung (Score pro Route + Findings)
 *   - reports/lighthouse-a11y/<timestamp>/<route>.json (Roh-Reports)
 *   - reports/lighthouse-a11y/<timestamp>/summary.md   (Markdown-Übersicht)
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = "http://localhost:3000";
const MAILPIT_URL = "http://127.0.0.1:54324";
const EMAIL = "skipper@example.com";

type Route = { path: string; label: string };

const STATIC_ROUTES: Route[] = [
  { path: "/", label: "Trips-Übersicht" },
];

async function fetchMagicLink(): Promise<string> {
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

  const match =
    body.match(/https?:\/\/[^\s"<>]+\/auth\/callback\?[^\s"<>]+/) ??
    body.match(/https?:\/\/[^\s"<>]+\/auth\/v1\/verify\?[^\s"<>]+/);
  if (!match) throw new Error("Kein Magic-Link in Mail gefunden");
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

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

type LhAudit = {
  id: string;
  title: string;
  description?: string;
  score: number | null;
  scoreDisplayMode?: string;
  details?: { items?: Array<{ node?: { snippet?: string; selector?: string }; selector?: string }> };
};

type LhReport = {
  categories: { accessibility: { score: number | null; auditRefs: Array<{ id: string; weight?: number }> } };
  audits: Record<string, LhAudit>;
  runtimeError?: { code: string; message: string };
};

type RouteResult = {
  label: string;
  path: string;
  score: number | null;
  failed: LhAudit[];
  manual: LhAudit[];
  notApplicable: number;
};

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportDir = resolve(__dirname, "../reports/lighthouse-a11y", timestamp);
  mkdirSync(reportDir, { recursive: true });

  console.log("→ Login via Playwright + Mailpit");
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.getByRole("button", { name: /Magic-Link anfordern/i }).click();
  await page.waitForTimeout(2000);

  const magicLink = await fetchMagicLink();
  console.log(`  ↳ Magic-Link: ${magicLink.slice(0, 80)}…`);
  await page.goto(magicLink);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Lokales Supabase setzt site_url auf 127.0.0.1:3000/ statt /auth/callback —
  // ?code= manuell durchschicken (gleicher Workaround wie in take-screenshots.ts).
  const code = new URL(page.url()).searchParams.get("code");
  if (code) {
    await page.goto(`${BASE_URL}/auth/callback?code=${code}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }

  await page.goto(BASE_URL);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Trip-ID aus der Liste fischen (UUID-Pattern, ignoriert /trips/new).
  const tripHrefs = await page.locator('a[href^="/trips/"]').evaluateAll((els) =>
    els
      .map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
      .filter((h) => /^\/trips\/[0-9a-f-]{36}$/.test(h)),
  );
  const tripId = tripHrefs[0]?.replace("/trips/", "");
  if (!tripId) throw new Error("Kein Trip in Liste — Seed (seed_demo.sql) gelaufen?");
  console.log(`  ↳ Trip-ID: ${tripId}`);

  const routes: Route[] = [
    ...STATIC_ROUTES,
    { path: `/trips/${tripId}`, label: "Trip-Cockpit" },
    { path: `/trips/${tripId}/transactions`, label: "Buchungen-Liste" },
    { path: `/trips/${tripId}/transactions/new`, label: "Buchung neu" },
    { path: `/trips/${tripId}/balance`, label: "Bilanz" },
    { path: `/trips/${tripId}/debts`, label: "Schulden" },
    { path: `/trips/${tripId}/stats`, label: "Statistik (pro Törn)" },
    { path: `/trips/${tripId}/settings`, label: "Trip-Settings" },
    { path: `/profile`, label: "Profil" },
    { path: `/stats`, label: "Gesamt-Statistik" },
  ];

  const cookies = await context.cookies();
  const cookieHeader = cookies
    .filter((c) => /localhost|127\.0\.0\.1/.test(c.domain))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  await browser.close();
  if (!cookieHeader) throw new Error("Keine Cookies extrahiert — Login fehlgeschlagen?");
  console.log(`  ↳ ${cookies.length} Cookies extrahiert (${cookieHeader.length} Bytes Header)`);

  const headersFile = resolve(reportDir, "_headers.json");
  writeFileSync(headersFile, JSON.stringify({ Cookie: cookieHeader }));

  const results: RouteResult[] = [];

  for (const route of routes) {
    const outFile = resolve(reportDir, `${slug(route.label)}.json`);
    console.log(`→ Lighthouse: ${route.label} (${route.path})`);

    const res = spawnSync(
      "npx",
      [
        "-y",
        "lighthouse@latest",
        `${BASE_URL}${route.path}`,
        "--only-categories=accessibility",
        "--form-factor=mobile",
        "--screen-emulation.mobile=true",
        "--screen-emulation.width=390",
        "--screen-emulation.height=844",
        "--screen-emulation.deviceScaleFactor=2",
        "--throttling-method=provided",
        `--extra-headers=${headersFile}`,
        "--chrome-flags=--headless=new --no-sandbox",
        "--quiet",
        "--output=json",
        `--output-path=${outFile}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    if (res.status !== 0) {
      console.log(`  ✗ Lighthouse-Lauf fehlgeschlagen (Exit ${res.status})`);
      const tail = res.stderr.toString().trim().split("\n").slice(-3).join("\n");
      if (tail) console.log(`    ${tail}`);
      continue;
    }

    let report: LhReport;
    try {
      report = JSON.parse(readFileSync(outFile, "utf8")) as LhReport;
    } catch (e) {
      console.log(`  ✗ Parse-Fehler: ${(e as Error).message}`);
      continue;
    }

    if (report.runtimeError) {
      console.log(`  ✗ Runtime-Fehler: ${report.runtimeError.code} — ${report.runtimeError.message}`);
      continue;
    }

    const failed: LhAudit[] = [];
    const manual: LhAudit[] = [];
    let notApplicable = 0;

    for (const ref of report.categories.accessibility.auditRefs) {
      const a = report.audits[ref.id];
      if (!a) continue;
      if (a.scoreDisplayMode === "manual") manual.push(a);
      else if (a.scoreDisplayMode === "notApplicable") notApplicable++;
      else if (a.score !== null && a.score < 1) failed.push(a);
    }

    const score = report.categories.accessibility.score === null
      ? null
      : Math.round(report.categories.accessibility.score * 100);

    results.push({ label: route.label, path: route.path, score, failed, manual, notApplicable });
    console.log(
      `  ↳ Score ${score ?? "?"}/100 — ${failed.length} failed, ${manual.length} manuell, ${notApplicable} n/a`,
    );
    for (const f of failed) {
      const items = f.details?.items?.slice(0, 2) ?? [];
      const snippets = items
        .map((it) => (it.node?.snippet ?? it.selector ?? "").slice(0, 90))
        .filter(Boolean);
      console.log(`     ✗ ${f.id}: ${f.title}`);
      for (const s of snippets) console.log(`        ${s}`);
    }
  }

  const md = buildMarkdownReport(results, timestamp);
  const mdFile = resolve(reportDir, "summary.md");
  writeFileSync(mdFile, md);

  console.log("\n=== ZUSAMMENFASSUNG ===");
  const maxLabel = Math.max(...results.map((r) => r.label.length), 0);
  for (const r of results) {
    const pad = " ".repeat(maxLabel - r.label.length + 2);
    console.log(`${r.label}${pad}${r.score ?? "?"}/100  (${r.failed.length} failed)`);
  }
  console.log(`\nReport: ${mdFile}`);
}

function buildMarkdownReport(results: RouteResult[], timestamp: string): string {
  const lines: string[] = [];
  lines.push(`# Lighthouse Accessibility-Audit (eingeloggt)`);
  lines.push("");
  lines.push(`Lauf: \`${timestamp}\``);
  lines.push("");
  lines.push(`Zielgruppe: **WCAG 2.1 AA**. Lighthouse-Accessibility-Audits decken den Großteil der`);
  lines.push(`automatisch testbaren AA-Kriterien ab (axe-core). Manuelle Checks (Tastatur-Navigation,`);
  lines.push(`Screenreader-Vorlesetexte, Fokus-Reihenfolge) bleiben separat zu prüfen — die`);
  lines.push(`"Manuell"-Spalte unten listet, was Lighthouse explizit dem Reviewer übergibt.`);
  lines.push("");
  lines.push(`## Übersicht`);
  lines.push("");
  lines.push(`| Route | Pfad | Score | Failed | Manuell |`);
  lines.push(`|---|---|---:|---:|---:|`);
  for (const r of results) {
    lines.push(`| ${r.label} | \`${r.path}\` | ${r.score ?? "?"}/100 | ${r.failed.length} | ${r.manual.length} |`);
  }
  lines.push("");

  const findingCounts = new Map<string, { title: string; description: string; routes: string[] }>();
  for (const r of results) {
    for (const f of r.failed) {
      const e = findingCounts.get(f.id) ?? { title: f.title, description: f.description ?? "", routes: [] };
      e.routes.push(r.label);
      findingCounts.set(f.id, e);
    }
  }
  if (findingCounts.size > 0) {
    lines.push(`## Häufige Findings (Cross-Route)`);
    lines.push("");
    const sorted = [...findingCounts.entries()].sort((a, b) => b[1].routes.length - a[1].routes.length);
    for (const [id, info] of sorted) {
      lines.push(`### \`${id}\` — ${info.title}`);
      lines.push("");
      if (info.description) lines.push(info.description.replace(/\n/g, " "));
      lines.push("");
      lines.push(`Betroffen: ${info.routes.length}× — ${info.routes.map((l) => `_${l}_`).join(", ")}`);
      lines.push("");
    }
  }

  lines.push(`## Details pro Route`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.label} — \`${r.path}\``);
    lines.push("");
    lines.push(`- Score: **${r.score ?? "?"}/100**`);
    lines.push(`- Failed: ${r.failed.length} · Manuell: ${r.manual.length} · Nicht anwendbar: ${r.notApplicable}`);
    lines.push("");
    if (r.failed.length === 0) {
      lines.push(`Keine automatisch erkannten AA-Verstöße. ✓`);
      lines.push("");
      continue;
    }
    for (const f of r.failed) {
      lines.push(`#### \`${f.id}\` — ${f.title}`);
      lines.push("");
      if (f.description) lines.push(f.description.replace(/\n/g, " "));
      lines.push("");
      const items = f.details?.items?.slice(0, 5) ?? [];
      if (items.length > 0) {
        lines.push("```html");
        for (const it of items) {
          const snippet = (it.node?.snippet ?? "").slice(0, 200);
          if (snippet) lines.push(snippet);
        }
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
