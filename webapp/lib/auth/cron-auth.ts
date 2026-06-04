import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Konstant-zeitlicher Vergleich zweier Strings. Verhindert, dass ein
 * Angreifer das CRON_SECRET zeichenweise über Antwortzeiten errät. Der
 * kurzschließende `===`-Vergleich (S-5) bricht beim ersten ungleichen Byte
 * ab und leakt damit theoretisch die Position des Fehlers.
 *
 * Längen-Guard: timingSafeEqual wirft bei ungleicher Pufferlänge, daher
 * vorher prüfen (die Länge selbst ist kein nennenswertes Geheimnis).
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Prüft den `Authorization: Bearer <CRON_SECRET>`-Header eines Cron-
 * Endpunkts. Fail-closed: ohne konfiguriertes Secret → 503, bei falschem
 * Token → 401. Der Token-Vergleich läuft konstant-zeitlich.
 */
export function verifyCronAuth(authHeader: string | null): CronAuthResult {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, error: "CRON_SECRET nicht konfiguriert." };
  }
  if (!authHeader || !safeEqual(authHeader, `Bearer ${expected}`)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}
