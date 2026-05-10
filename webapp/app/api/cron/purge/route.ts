import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Cron-Endpoint für die DSGVO-Datenlöschung.
 *
 * Wird täglich von Vercel Cron aufgerufen (siehe vercel.json) und ruft
 * die Postgres-Function purge_expired_trip_data() — sie löscht alle
 * personenbezogenen Daten von Törns, deren Ende mehr als 30 Tage zurück
 * liegt, und schreibt vorher ein anonymisiertes Statistik-Aggregat in
 * trip_statistics.
 *
 * Sicherheit: Vercel-Cron sendet im Header
 *     Authorization: Bearer <CRON_SECRET>
 * Wir vergleichen das mit der Env-Variable CRON_SECRET. Schlägt fehl,
 * wenn das Secret nicht gesetzt ist (fail-closed).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET nicht konfiguriert." },
      { status: 503 },
    );
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("purge_expired_trip_data");

  if (error) {
    console.error("purge_expired_trip_data failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    purged_trips: data ?? 0,
    ranAt: new Date().toISOString(),
  });
}
