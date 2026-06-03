import "server-only";
import webpush from "web-push";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { PushPayload } from "@/lib/notify/payloads";

type AdminClient = ReturnType<typeof createAdminClient>;

// VAPID einmal pro Prozess konfigurieren. null = noch nicht versucht.
let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:bordkasse@dieter.ms";
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export interface PushResult {
  /** Erfolgreich zugestellt. */
  sent: number;
  /** Echter Zustellfehler (≠ abgelaufenes Abo). */
  failed: number;
  /** Tote Abos (404/410), die entfernt wurden. */
  removed: number;
}

/**
 * Verschickt einen Web-Push an ALLE Geräte-Abos der angegebenen Personen.
 *
 * Vertrag wie `sendMail`: wirft NIE — Fehler werden geloggt und gezählt, der
 * aufrufende (Mail-)Pfad läuft ungestört weiter. Push ist rein additiv; die
 * Mail bleibt der verlässliche Kanal.
 *
 * Abos, die der Push-Dienst mit 404/410 („Gone") quittiert, sind tot (PWA
 * deinstalliert, Permission entzogen, Endpoint abgelaufen) und werden
 * gelöscht — sonst sammeln sich Leichen, und ein recycelter Endpoint könnte
 * irgendwann ein fremdes Gerät treffen.
 *
 * Die `personIds` müssen bereits gefiltert sein (Actor-Exclusion via
 * `pushRecipients`); diese Funktion macht keine Empfänger-Politik, nur Versand.
 */
export async function sendPushToPersons(
  supabase: AdminClient,
  personIds: string[],
  payload: PushPayload,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };

  const ids = Array.from(new Set(personIds.filter(Boolean)));
  if (ids.length === 0) return result;

  if (!ensureConfigured()) {
    console.warn("[bordkasse:push] VAPID nicht konfiguriert — Push übersprungen.");
    return result;
  }

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("person_id", ids);
  if (error) {
    console.error("[bordkasse:push] Abo-Abfrage fehlgeschlagen:", error.message);
    return result;
  }
  if (!subs || subs.length === 0) return result;

  const body = JSON.stringify(payload);
  const stale: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          // 24 h Time-To-Live: was der Push-Dienst bis dahin nicht zustellt,
          // ist verworfen — die Info liegt ohnehin parallel als Mail vor.
          { TTL: 60 * 60 * 24 },
        );
        result.sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          stale.push(s.id);
        } else {
          result.failed += 1;
          console.error("[bordkasse:push] Zustellung fehlgeschlagen", { sub: s.id, statusCode });
        }
      }
    }),
  );

  if (stale.length > 0) {
    const { error: delErr } = await supabase.from("push_subscriptions").delete().in("id", stale);
    if (delErr) console.error("[bordkasse:push] Cleanup fehlgeschlagen:", delErr.message);
    else result.removed = stale.length;
  }

  return result;
}
