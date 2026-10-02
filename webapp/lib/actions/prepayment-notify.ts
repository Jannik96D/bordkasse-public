"use server";

/**
 * Knopf „Crew informieren" (PR6): schickt nach einer Änderung am
 * Anzahlungsplan bzw. an einem Reise-Posten eine Update-Mail („hat sich
 * geändert", aktuelle Beträge/Fristen) + Push an alle Betroffenen.
 *
 * Bewusst manuell: Änderungen lösen KEINE automatische Mail aus — sonst bekäme
 * die Crew bei jedem Tippfehler-Fix eine Mail. Nur Skipper/Co-Skipper/Admin
 * (requireSkipperOrAdmin), archivierte Törns verschicken nichts. Weicher
 * Spam-Schutz: der letzte Versand steht als „zuletzt informiert am …" am
 * Knopf (crew_last_notified_at, Migration 0062), kein harter Block — der
 * Skipper entscheidet.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { assertTripNotArchived } from "@/lib/auth/trip-state";
import { itemBelongsToTrip } from "@/lib/auth/cross-trip";
import { logAudit } from "@/lib/db/audit";
import { sendItemAnnouncement, sendPlanAnnouncement, type NoticeResult } from "@/lib/email/send-prepayment-notices";

export type NotifyCrewResult =
  | { status: "ok"; sent: number; failed: number; skipped: number }
  | { status: "error"; message: string };

const Uuid = z.string().uuid();

function toResult(r: NoticeResult): NotifyCrewResult {
  if (r.error) return { status: "error", message: r.error };
  return { status: "ok", sent: r.sent, failed: r.failed, skipped: r.skipped };
}

export async function notifyPlanCrew(tripId: string): Promise<NotifyCrewResult> {
  if (!Uuid.safeParse(tripId).success) return { status: "error", message: "Ungültige Eingabe." };
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const archived = await assertTripNotArchived(supabase, tripId);
  if (!archived.ok) return { status: "error", message: archived.message };

  const result = await sendPlanAnnouncement(supabase, { tripId, actorId: auth.personId, isUpdate: true });
  if (!result.error) {
    await logAudit(supabase, {
      table_name: "prepayment_plan",
      operation: "UPDATE",
      record_id: tripId,
      trip_id: tripId,
      actor_person_id: auth.personId,
      // Nur Zählungen — keine Namen/Adressen (Audit ohne Klartext-PII).
      payload: { kind: "crew-notified", sent: result.sent, failed: result.failed, skipped: result.skipped },
    });
  }
  revalidatePath(`/trips/${tripId}/prepayments`);
  return toResult(result);
}

export async function notifyItemCrew(tripId: string, itemId: string): Promise<NotifyCrewResult> {
  if (!Uuid.safeParse(tripId).success || !Uuid.safeParse(itemId).success) {
    return { status: "error", message: "Ungültige Eingabe." };
  }
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const archived = await assertTripNotArchived(supabase, tripId);
  if (!archived.ok) return { status: "error", message: archived.message };
  // Cross-Trip: der Posten muss zu DIESEM Törn gehören (Rolle gilt nur dort).
  if (!(await itemBelongsToTrip(supabase, itemId, tripId))) {
    return { status: "error", message: "Dieser Posten gehört nicht zu diesem Törn. Bitte Seite neu laden." };
  }

  const result = await sendItemAnnouncement(supabase, { tripId, itemId, actorId: auth.personId, isUpdate: true });
  if (!result.error) {
    await logAudit(supabase, {
      table_name: "prepayment_items",
      operation: "UPDATE",
      record_id: itemId,
      trip_id: tripId,
      actor_person_id: auth.personId,
      payload: { kind: "crew-notified", sent: result.sent, failed: result.failed, skipped: result.skipped },
    });
  }
  revalidatePath(`/trips/${tripId}/prepayments`);
  return toResult(result);
}
