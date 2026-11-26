import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Sicherheitsrunde 2026-11, Slice 10 — Limit pro (Akteur, Aktion, Törn) für
 * Aktionen, die Mails an Dritte auslösen. Nutzt die bestehende Funktion
 * `bump_login_rate_limit` (Migration 0036) mit eigenem Schlüsselpräfix — keine
 * neue Migration. Der Zähler ist atomar (ein Row-Lock in der DB).
 *
 * Fail-open: ist die DB nicht erreichbar, wird die Aktion NICHT blockiert. Das
 * Limit ist ein Schutznetz gegen Missbrauch durch ein eingeloggtes
 * Skipper-Konto, kein Auth-Gate (Rolle und Zuständigkeit prüft der
 * Aufrufer vorher); eine echte Crew-Anlage am Törn-Start soll an einem
 * DB-Schluckauf nicht scheitern.
 */
export async function withinActionLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("bump_login_rate_limit", {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[bordkasse:ratelimit] action:", error.code ?? "unknown");
      return true; // fail-open
    }
    return data !== false;
  } catch {
    console.error("[bordkasse:ratelimit] action: exception");
    return true; // fail-open
  }
}

/** Einladungen: 30 pro Stunde je (Akteur, Törn) UND 60 pro Stunde je Akteur über alle Törns. */
export const INVITE_LIMIT_MAX = 30;
export const INVITE_LIMIT_GLOBAL_MAX = 60;
export const INVITE_LIMIT_WINDOW_SECONDS = 60 * 60;
export const INVITE_LIMIT_MESSAGE =
  "Es wurden gerade sehr viele Einladungen verschickt. Bitte in einer Stunde erneut versuchen.";

export function inviteLimitKey(actorId: string, tripId: string): string {
  return `invite:${actorId}:${tripId}`;
}

export function inviteGlobalLimitKey(actorId: string): string {
  return `invite:${actorId}`;
}

/** Beide Zähler werden immer hochgezählt (kein Kurzschluss), erlaubt nur, wenn beide erlauben. */
export async function withinInviteLimit(actorId: string, tripId: string): Promise<boolean> {
  const [perTrip, global] = await Promise.all([
    withinActionLimit(inviteLimitKey(actorId, tripId), INVITE_LIMIT_MAX, INVITE_LIMIT_WINDOW_SECONDS),
    withinActionLimit(inviteGlobalLimitKey(actorId), INVITE_LIMIT_GLOBAL_MAX, INVITE_LIMIT_WINDOW_SECONDS),
  ]);
  return perTrip && global;
}
