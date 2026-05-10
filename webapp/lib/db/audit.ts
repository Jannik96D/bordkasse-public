import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditOperation = "INSERT" | "UPDATE" | "DELETE";

export type AuditEntry = {
  table_name: string;
  operation: AuditOperation;
  record_id: string;
  trip_id?: string | null;
  actor_person_id: string;
  payload?: Record<string, unknown> | null;
};

/**
 * Append-only Logbuch für Schreib-Operationen.
 *
 * Fehler werden bewusst geschluckt + nur geloggt — wenn das Audit-Schreiben
 * fehlschlägt, soll die eigentliche Operation trotzdem als Erfolg
 * zurückkommen. Audit ist Nice-to-have, kein blocker.
 */
export async function logAudit(
  supabase: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from("audit_log").insert({
      table_name: entry.table_name,
      operation: entry.operation,
      record_id: entry.record_id,
      trip_id: entry.trip_id ?? null,
      actor_person_id: entry.actor_person_id,
      payload: entry.payload ?? null,
    });
    if (error) {
      console.error("audit_log insert failed:", error.message);
    }
  } catch (err) {
    console.error("audit_log threw:", err);
  }
}
