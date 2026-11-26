/**
 * Sicherheitsrunde 2026-11, Slice 18: das JWT-Secret darf nicht wieder als
 * Datenbankeinstellung `app.settings.jwt_secret` landen — sie ist per
 * `current_setting()` für jede Rolle lesbar. Zwei Quellen gab es: PostgREST
 * (`PGRST_APP_SETTINGS_JWT_SECRET`, je Anfrage) und das Init-Skript
 * `volumes/db/jwt.sql` (bei der Erstinitialisierung).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const selfHost = join(__dirname, "..", "supabase", "self-host");

/** Kommentarzeilen entfernen, damit die Begründung im Kommentar nicht zählt. */
function code(text: string, comment: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith(comment))
    .join("\n");
}

describe("JWT-Secret nicht als DB-Einstellung (Slice 18)", () => {
  it("PostgREST setzt app.settings.jwt_secret nicht", () => {
    const compose = code(readFileSync(join(selfHost, "docker-compose.yml"), "utf8"), "#");
    expect(compose).not.toMatch(/PGRST_APP_SETTINGS_JWT_SECRET/);
    // Gegenprobe: PostgREST prüft Tokens weiterhin über PGRST_JWT_SECRET.
    expect(compose).toMatch(/PGRST_JWT_SECRET:\s*\$\{JWT_SECRET\}/);
  });

  it("das DB-Init-Skript setzt app.settings.jwt_secret nicht", () => {
    const sql = code(readFileSync(join(selfHost, "volumes", "db", "jwt.sql"), "utf8"), "--");
    expect(sql).not.toMatch(/jwt_secret/i);
  });
});
