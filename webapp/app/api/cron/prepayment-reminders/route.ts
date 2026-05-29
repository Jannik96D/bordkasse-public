import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPrepaymentReminderMail } from "@/lib/email/send-prepayment-reminder";
import { CREW_DUE_DAYS_BEFORE_CHARTER } from "@/lib/prepayments/dates";

/**
 * Täglicher Cron — verschickt Anzahlungs-Erinnerungen 3 Tage vor der
 * jeweiligen Fälligkeit:
 *
 *   - "crew_3d"      → 3 Tage vor Crew-Fälligkeit (= 6 Tage vor Charter-Frist)
 *                       an alle Crew-Mitglieder mit offenem Betrag in dieser
 *                       Tranche. Vorstrecker wird übersprungen (eigene Mail).
 *
 *   - "advancer_3d"  → 3 Tage vor Charter-Fälligkeit (= echtes due_date in 3 Tagen)
 *                       an den Vorstrecker — mit der Charter-Übersicht für
 *                       diese Tranche.
 *
 * Dedup-Mechanik: `prepayment_reminder_log` hält pro (tranche × person × type)
 * höchstens einen Eintrag. Vor jedem Versand prüfen, beim erfolgreichen
 * Versand eintragen. So spammen wir nicht, falls Vercel den Cron mehrfach
 * triggert.
 *
 * Sicherheit: Bearer-Token-Check via CRON_SECRET (siehe purge-Cron).
 */
export const dynamic = "force-dynamic";

const REMINDER_DAYS_BEFORE = 3;

interface ReminderJob {
  trancheId: string;
  tripId: string;
  personId: string;
  type: "crew_3d" | "advancer_3d";
}

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

  // Heutiges Datum in UTC (Cron läuft in UTC, due_date ist in DATE = UTC-frei).
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  // Target-Datum für "advancer_3d": charter_due_date == today + 3 days
  const advancerTarget = addDays(todayIso, REMINDER_DAYS_BEFORE);
  // Target-Datum für "crew_3d": crew_due_date == today + 3 days
  // crew_due_date = charter_due_date - CREW_DUE_DAYS_BEFORE_CHARTER
  // → charter_due_date = today + 3 + CREW_DUE_DAYS_BEFORE_CHARTER
  const crewTarget = addDays(todayIso, REMINDER_DAYS_BEFORE + CREW_DUE_DAYS_BEFORE_CHARTER);

  // Tranchen mit relevanten Fälligkeitsdaten laden + Trip-Daten (skipper_id
  // als Vorstrecker-Fallback, end_date um abgeschlossene Trips auszuschließen).
  const { data: tranches, error: trancheErr } = await supabase
    .from("prepayment_tranches")
    .select("id, trip_id, label, due_date, percent")
    .in("due_date", [advancerTarget, crewTarget]);
  if (trancheErr) {
    console.error("[bordkasse:cron] tranche query failed:", trancheErr.message);
    return NextResponse.json({ ok: false, error: trancheErr.message }, { status: 500 });
  }
  if (!tranches || tranches.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, sent: 0, skipped: 0, ranAt: new Date().toISOString() });
  }

  const tripIds = Array.from(new Set(tranches.map((t) => t.trip_id)));

  const [{ data: trips }, { data: plans }, { data: obligations }, { data: payments }, { data: logRows }] =
    await Promise.all([
      supabase.from("trips").select("id, name, skipper_id, end_date").in("id", tripIds),
      supabase
        .from("prepayment_plan")
        .select("trip_id, advancer_person_id, total_amount")
        .in("trip_id", tripIds),
      supabase
        .from("prepayment_obligations")
        .select("trip_id, person_id, total_amount")
        .in("trip_id", tripIds),
      supabase
        .from("v_prepayment_payments")
        .select("trip_id, tranche_id, person_id, paid_amount")
        .in("trip_id", tripIds),
      supabase
        .from("prepayment_reminder_log")
        .select("tranche_id, person_id, reminder_type")
        .in("tranche_id", tranches.map((t) => t.id)),
    ]);

  const tripById = new Map(
    (trips ?? []).map((t) => [t.id, t as { id: string; name: string; skipper_id: string; end_date: string }]),
  );
  const planByTrip = new Map(
    (plans ?? []).map((p) => [
      p.trip_id,
      p as { trip_id: string; advancer_person_id: string | null; total_amount: number },
    ]),
  );

  // Soll pro Person/Trip
  const sollByTripPerson = new Map<string, number>();
  for (const o of obligations ?? []) {
    sollByTripPerson.set(`${o.trip_id}::${o.person_id}`, Number(o.total_amount));
  }

  // Bezahlt pro Tranche/Person
  const paidByTranchePerson = new Map<string, number>();
  for (const p of payments ?? []) {
    if (p.tranche_id && p.person_id) {
      const key = `${p.tranche_id}::${p.person_id}`;
      paidByTranchePerson.set(key, (paidByTranchePerson.get(key) ?? 0) + Number(p.paid_amount));
    }
  }

  // Bereits verschickt — Dedup-Set
  const alreadySent = new Set<string>();
  for (const r of logRows ?? []) {
    alreadySent.add(`${r.tranche_id}::${r.person_id}::${r.reminder_type}`);
  }

  const jobs: ReminderJob[] = [];

  for (const t of tranches) {
    const trip = tripById.get(t.trip_id);
    if (!trip) continue;
    // Bereits abgelaufene Trips überspringen (Anzahlungs-Mahnung nach Törn macht keinen Sinn)
    if (trip.end_date && trip.end_date < todayIso) continue;

    const plan = planByTrip.get(t.trip_id);
    if (!plan) continue;
    const advancerId = plan.advancer_person_id ?? trip.skipper_id;

    if (t.due_date === advancerTarget) {
      // Vorstrecker-Reminder: ein Empfänger pro Tranche.
      const key = `${t.id}::${advancerId}::advancer_3d`;
      if (!alreadySent.has(key)) {
        jobs.push({ trancheId: t.id, tripId: t.trip_id, personId: advancerId, type: "advancer_3d" });
      }
    }

    if (t.due_date === crewTarget) {
      // Crew-Reminder: alle Crew-Mitglieder, deren Soll > 0 und noch
      // nicht voll bezahlt — Vorstrecker übersprungen.
      const tripPersons = Array.from(
        new Set(
          (obligations ?? [])
            .filter((o) => o.trip_id === t.trip_id && o.person_id !== advancerId)
            .map((o) => o.person_id),
        ),
      );
      for (const personId of tripPersons) {
        const totalSoll = sollByTripPerson.get(`${t.trip_id}::${personId}`) ?? 0;
        if (totalSoll <= 0) continue;
        const trancheSoll = (totalSoll * Number(t.percent)) / 100;
        const paid = paidByTranchePerson.get(`${t.id}::${personId}`) ?? 0;
        if (trancheSoll - paid <= 0.005) continue;
        const key = `${t.id}::${personId}::crew_3d`;
        if (alreadySent.has(key)) continue;
        jobs.push({ trancheId: t.id, tripId: t.trip_id, personId, type: "crew_3d" });
      }
    }
  }

  let sent = 0;
  let skipped = 0;
  const errors: Array<{ job: ReminderJob; message: string }> = [];

  for (const job of jobs) {
    try {
      const result = await sendPrepaymentReminderMail({
        tripId: job.tripId,
        personId: job.personId,
        trancheId: job.trancheId,
        isAutomated: true,
      });
      if (!result.ok) {
        skipped++;
        errors.push({ job, message: result.message });
        continue;
      }
      const { error: logErr } = await supabase.from("prepayment_reminder_log").insert({
        trip_id: job.tripId,
        tranche_id: job.trancheId,
        person_id: job.personId,
        reminder_type: job.type,
      });
      if (logErr) {
        // Unique-Violation = parallele Cron-Instanz hat schon gelogged — egal.
        console.warn("[bordkasse:cron] log insert:", logErr.message);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[bordkasse:cron] job failed:", { job, msg });
      errors.push({ job, message: msg });
      skipped++;
    }
  }

  return NextResponse.json({
    ok: true,
    processed: jobs.length,
    sent,
    skipped,
    errors: errors.map((e) => ({ type: e.job.type, message: e.message })),
    ranAt: new Date().toISOString(),
  });
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
