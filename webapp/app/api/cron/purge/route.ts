import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyCronAuth } from "@/lib/auth/cron-auth";

/**
 * Cron-Endpoint für die DSGVO-Datenlöschung.
 *
 * Wird täglich um 03:00 vom Coolify Scheduled Task `purge-node` aufgerufen
 * (Kommando + Fallstricke: docs/self-hosting.md, „Die beiden Crons") und ruft
 * die Postgres-Function purge_expired_trip_data() — sie löscht alle
 * personenbezogenen Daten von Törns, deren Ende mehr als 30 Tage zurück
 * liegt, und schreibt vorher ein anonymisiertes Statistik-Aggregat in
 * trip_statistics.
 *
 * Sicherheit: der Cron-Task sendet im Header
 *     Authorization: Bearer <CRON_SECRET>
 * Wir vergleichen das mit der Env-Variable CRON_SECRET. Schlägt fehl,
 * wenn das Secret nicht gesetzt ist (fail-closed).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cronAuth = verifyCronAuth(request.headers.get("authorization"));
  if (!cronAuth.ok) {
    return NextResponse.json({ ok: false, error: cronAuth.error }, { status: cronAuth.status });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("purge_expired_trip_data");

  if (error) {
    console.error("purge_expired_trip_data failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Alte Login-Rate-Limit-Zähler aufräumen (Migration 0036). Nicht fatal —
  // ein Fehler hier darf den Purge-Erfolg nicht überschreiben.
  const { error: rlError } = await supabase.rpc("cleanup_login_rate_limit");
  if (rlError) console.error("cleanup_login_rate_limit failed:", rlError.message);

  // Seit Migration 0048 liefert die Funktion zusätzlich die Zahl der Törns,
  // die mit einem Fehler übersprungen wurden. Vorher verschwand das
  // ausschließlich in einer Postgres-WARNING, und der Cron meldete
  // `purged_trips: 0` — ununterscheidbar von „heute war nichts fällig".
  // Genau deshalb blieb eine verfehlte DSGVO-Löschfrist wochenlang unbemerkt.
  const row = Array.isArray(data) ? data[0] : data;
  const purged = row?.purged ?? 0;
  const failed = row?.failed ?? 0;

  if (failed > 0) {
    console.error(
      `[bordkasse:purge] ${failed} Törn(s) konnten nicht gelöscht werden — Details als WARNING im Postgres-Log. Die DSGVO-Frist läuft für diese Törns weiter.`,
    );
  }

  return NextResponse.json({
    ok: true,
    purged_trips: purged,
    failed_trips: failed,
    ranAt: new Date().toISOString(),
  });
}
