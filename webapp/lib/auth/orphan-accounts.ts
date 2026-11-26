import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { authAnchorOf } from "@/lib/auth/ensure-auth-user";
import { getAdminEmails } from "@/lib/auth/admin-emails";

/**
 * Sicherheitsrunde 2026-11, Slice 10 — verwaiste Auth-Konten aufräumen.
 *
 * Einladungen und Login-Versuche legen über `ensureAuthUser` ein Konto in
 * `auth.users` an. Wird die Person danach nie angelegt/entfernt
 * (`removeMember`, geänderte E-Mail, Purge) oder der Link nie benutzt, bliebe
 * die Adresse dauerhaft in der Auth-Tabelle stehen (DSGVO-Rest). Der tägliche
 * Purge-Cron ruft deshalb diese Aufräumung.
 *
 * Gelöscht wird ein Konto NUR, wenn ALLE Bedingungen gelten:
 *   - älter als `ORPHAN_MIN_AGE_DAYS` (Erstellung UND letzte Anmeldung) — ein
 *     frisch eingeladenes oder gerade angelegtes Login-Konto hat bis zum Klick
 *     auf den Link (60 Min) noch keine Person;
 *   - keine Person verknüpft (`persons.auth_user_id`);
 *   - kein `persons_private`-Eintrag mit der Konto-Adresse oder der
 *     Anker-Adresse (ein eingeladenes, noch nie eingeloggtes Mitglied hat
 *     genau so einen Eintrag);
 *   - nicht in `ADMIN_EMAILS`.
 * Löschen läuft über die Admin-API (`auth.admin.deleteUser`, räumt
 * Sessions/Identitäten mit ab), nie per SQL. Bei JEDEM Lesefehler wird
 * abgebrochen und nichts gelöscht (fail-closed) — gelöscht wird nur auf
 * Basis vollständiger Information. Ein gelöschtes Konto entsteht beim
 * nächsten legitimen Login/der nächsten Einladung über `ensureAuthUser`
 * neu.
 */
export const ORPHAN_MIN_AGE_DAYS = 7;
/** Obergrenze je Lauf — begrenzt die Laufzeit; der Rest folgt am nächsten Tag. */
const MAX_DELETIONS_PER_RUN = 100;
const MAX_LIST_PAGES = 50;
const PER_PAGE = 1000;
const IN_CHUNK = 100;

export type OrphanCleanupResult = { deleted: number; failed: number };

type Admin = ReturnType<typeof createAdminClient>;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function cleanupOrphanAuthUsers(
  admin: Admin = createAdminClient(),
  now: number = Date.now(),
): Promise<OrphanCleanupResult> {
  const cutoff = now - ORPHAN_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const adminEmails = new Set(getAdminEmails().map((e) => e.toLowerCase()));

  // 1. Kandidaten: alte Konten (alle Seiten lesen).
  type Candidate = { id: string; email: string | null; anchor: string | null };
  const candidates: Candidate[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      console.error("[bordkasse:orphan-accounts] listUsers fehlgeschlagen:", error.code ?? "unknown");
      return { deleted: 0, failed: 1 };
    }
    const users = data?.users ?? [];
    for (const u of users) {
      const created = Date.parse(u.created_at ?? "");
      const lastSeen = u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : 0;
      // Unlesbares Datum -> nie anfassen.
      if (!Number.isFinite(created)) continue;
      if (created > cutoff || lastSeen > cutoff) continue;
      const email = u.email ? u.email.trim().toLowerCase() : null;
      if (email && adminEmails.has(email)) continue;
      candidates.push({ id: u.id, email, anchor: authAnchorOf(u.app_metadata) });
    }
    if (users.length < PER_PAGE) break;
  }
  if (candidates.length === 0) return { deleted: 0, failed: 0 };

  // 2. Kandidaten mit Person-Verknüpfung ausschließen.
  const linked = new Set<string>();
  for (const part of chunks(candidates.map((c) => c.id), IN_CHUNK)) {
    const { data, error } = await admin.from("persons").select("auth_user_id").in("auth_user_id", part);
    if (error) {
      console.error("[bordkasse:orphan-accounts] persons-Abfrage fehlgeschlagen:", error.code ?? "unknown");
      return { deleted: 0, failed: 1 };
    }
    for (const r of data ?? []) if (r.auth_user_id) linked.add(String(r.auth_user_id));
  }
  const unlinked = candidates.filter((c) => !linked.has(c.id));
  if (unlinked.length === 0) return { deleted: 0, failed: 0 };

  // 3. Kandidaten, deren Konto- oder Anker-Adresse noch in persons_private
  //    steht (eingeladen, aber noch nie eingeloggt), ausschließen.
  const addresses = Array.from(
    new Set(unlinked.flatMap((c) => [c.email, c.anchor]).filter((a): a is string => !!a)),
  );
  const known = new Set<string>();
  for (const part of chunks(addresses, IN_CHUNK)) {
    const { data, error } = await admin.from("persons_private").select("email").in("email", part);
    if (error) {
      console.error("[bordkasse:orphan-accounts] persons_private-Abfrage fehlgeschlagen:", error.code ?? "unknown");
      return { deleted: 0, failed: 1 };
    }
    for (const r of data ?? []) if (r.email) known.add(String(r.email).trim().toLowerCase());
  }
  const orphans = unlinked.filter(
    (c) => !(c.email && known.has(c.email)) && !(c.anchor && known.has(c.anchor)),
  );

  // 4. Löschen — Fehler zählen separat und brechen den Lauf nicht ab.
  let deleted = 0;
  let failed = 0;
  for (const o of orphans.slice(0, MAX_DELETIONS_PER_RUN)) {
    try {
      const { error } = await admin.auth.admin.deleteUser(o.id);
      if (error) {
        failed += 1;
        console.error("[bordkasse:orphan-accounts] deleteUser fehlgeschlagen:", error.code ?? "unknown");
      } else {
        deleted += 1;
      }
    } catch {
      failed += 1;
      console.error("[bordkasse:orphan-accounts] deleteUser: exception");
    }
  }
  return { deleted, failed };
}
