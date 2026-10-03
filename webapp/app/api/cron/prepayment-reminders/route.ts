import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyCronAuth } from "@/lib/auth/cron-auth";
import { sendPrepaymentReminderMail } from "@/lib/email/send-prepayment-reminder";
import { CREW_DUE_DAYS_BEFORE_CHARTER, addDays, formatDeDate, toCrewDueDate } from "@/lib/prepayments/dates";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { prepaymentReminderPush, charterReminderPush } from "@/lib/notify/payloads";
import { runItemReminders, safeMailErrorMessage, type ItemReminderRunResult } from "@/lib/prepayments/item-reminder-cron";

/**
 * Täglicher Cron — verschickt Anzahlungs-Erinnerungen 3 Tage vor der
 * jeweiligen Fälligkeit:
 *
 *   - "crew_3d"      → 3 Tage vor Crew-Fälligkeit (= 6 Tage vor Charterfrist)
 *                       an alle Crewmitglieder mit offenem Betrag in dieser
 *                       Tranche. Vorstrecker wird übersprungen (eigene Mail).
 *
 *   - "advancer_3d"  → 3 Tage vor Charter-Fälligkeit (= echtes due_date in 3 Tagen)
 *                       an den Vorstrecker — nur wenn er dem Vercharterer noch was
 *                       schuldet. Hat er die Tranche bereits voll überwiesen,
 *                       wird übersprungen.
 *
 * Datums-Fenster statt exaktem Tag: wir akzeptieren JEDE Tranche, deren
 * Frist innerhalb der nächsten REMINDER_DAYS_BEFORE … REMINDER_DAYS_BEFORE
 * + CREW_DUE_DAYS_BEFORE_CHARTER Tage liegt. Damit verlieren wir keinen
 * Reminder, wenn der Cron einen Tag ausfällt — der Dedup-Log sorgt
 * dafür, dass jede Person × Tranche × Typ-Kombi nur einmal eine Mail
 * bekommt.
 *
 * Pending-Awareness: eine bereits selbst-gemeldete (aber noch nicht
 * bestätigte) Zahlung wird beim Crew-Reminder als "schon erledigt"
 * gewertet — die Person hat ihren Teil getan und wartet auf den
 * Vorstrecker. Sonst würde der Cron sie weiter mahnen, obwohl sie in
 * der App ⏳ pending steht.
 *
 * Reise-Posten (PR5, Migration 0061): derselbe Lauf verschickt zusätzlich
 * `item_crew_3d` / `item_payee_3d` (lib/prepayments/item-reminder-cron.ts).
 * Der Posten-Teil ist fail-soft, läuft NACH dem Tranchen-Teil (auch wenn
 * dieser scheitert) und hat ein eigenes Zeitbudget; die Top-Level-Zähler (`processed`/`sent`/`skipped`/`failed`) sind
 * die Summe beider Teile, `tranches` und `items` schlüsseln sie auf.
 *
 * Sicherheit: Bearer-Token-Check via CRON_SECRET (siehe purge-Cron).
 */
export const dynamic = "force-dynamic";

const REMINDER_DAYS_BEFORE = 3;
const CREW_WINDOW_MAX_DAYS = REMINDER_DAYS_BEFORE + CREW_DUE_DAYS_BEFORE_CHARTER;
const FLOAT_TOL = 0.005;

interface ReminderJob {
  trancheId: string;
  tripId: string;
  personId: string;
  type: "crew_3d" | "advancer_3d";
  // Für den Push-Payload (zusätzlich zur Mail) am Versand-Punkt verfügbar.
  trancheLabel: string;
  tripName: string;
  amount: number;
  /** Echte Charterfrist (ISO) — für die Frist im Push. */
  dueDate: string;
}

export async function GET(request: NextRequest) {
  const cronAuth = verifyCronAuth(request.headers.get("authorization"));
  if (!cronAuth.ok) {
    return NextResponse.json({ ok: false, error: cronAuth.error }, { status: cronAuth.status });
  }

  const supabase = createAdminClient();

  // Heutiges Datum in UTC (Cron läuft in UTC, due_date ist in DATE = UTC-frei).
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  // Tranchen ZUERST (Review P2: der Posten-Teil hat ein eigenes Zeitbudget,
  // darf die Charter-Erinnerungen aber nie verdrängen). Ein Fehler hier
  // verhindert den Posten-Teil nicht.
  let trancheResult: PartResult | { error: string };
  try {
    trancheResult = await runTrancheReminders(supabase, todayIso);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[bordkasse:cron] tranche part failed:", message);
    trancheResult = { error: message };
  }

  // Posten danach: wirft nie, ein Fehler dort (z. B. Tabelle aus 0061 fehlt)
  // zählt als `failed`; eigenes Zeitbudget (ITEM_TIME_BUDGET_MS).
  const items = await runItemReminders(supabase, todayIso);

  if ("error" in trancheResult) {
    return NextResponse.json(
      { ok: false, error: trancheResult.error, items: summarize(items), ranAt: new Date().toISOString() },
      { status: 500 },
    );
  }
  return NextResponse.json(combine(trancheResult, items));
}

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

/** Tranchen-Teil (Bestand, unverändert bis auf die Rückgabe statt Response). */
async function runTrancheReminders(supabase: SupabaseAdmin, todayIso: string): Promise<PartResult | { error: string }> {
  // Fenster: jede Tranche, deren Charterfrist in [heute, heute + max] liegt.
  // Innerhalb des Fensters entscheiden wir pro Tranche, ob crew_3d (≥ 6 Tage
  // vorher) und/oder advancer_3d (≥ 3 Tage vorher) angesagt sind. Vergangene
  // Fristen werden NICHT mehr beworben.
  const windowEnd = addDays(todayIso, CREW_WINDOW_MAX_DAYS);

  const { data: tranches, error: trancheErr } = await supabase
    .from("prepayment_tranches")
    .select("id, trip_id, label, due_date, percent")
    .gte("due_date", todayIso)
    .lte("due_date", windowEnd);
  if (trancheErr) {
    console.error("[bordkasse:cron] tranche query failed:", trancheErr.message);
    return { error: trancheErr.message };
  }
  if (!tranches || tranches.length === 0) {
    return { processed: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  }

  const tripIds = Array.from(new Set(tranches.map((t) => t.trip_id)));
  const trancheIds = tranches.map((t) => t.id);

  // Bulk-Load: alles für die betroffenen Trips/Tranchen parallel.
  // - confirmed payments aus v_prepayment_payments (für Soll-vs-Ist der Crew)
  // - pending self-reports aus v_prepayment_pending (zählen als "Person hat gemeldet")
  // - charter expenses (Vorstrecker → Vercharterer) für advancer-skip
  const [
    { data: trips },
    { data: plans },
    { data: obligations },
    { data: payments },
    { data: pendingRows },
    { data: charterExpenses },
    { data: logRows },
  ] = await Promise.all([
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
      .from("v_prepayment_pending")
      .select("trip_id, tranche_id, person_id")
      .in("trip_id", tripIds),
    supabase
      .from("transactions")
      .select("trip_id, tranche_id, amount")
      .in("trip_id", tripIds)
      .eq("type", "expense")
      .is("deleted_at", null)
      .not("tranche_id", "is", null),
    supabase
      .from("prepayment_reminder_log")
      .select("tranche_id, person_id, reminder_type")
      .in("tranche_id", trancheIds),
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

  const sollByTripPerson = new Map<string, number>();
  for (const o of obligations ?? []) {
    sollByTripPerson.set(`${o.trip_id}::${o.person_id}`, Number(o.total_amount));
  }

  const paidByTranchePerson = new Map<string, number>();
  for (const p of payments ?? []) {
    if (p.tranche_id && p.person_id) {
      const key = `${p.tranche_id}::${p.person_id}`;
      paidByTranchePerson.set(key, (paidByTranchePerson.get(key) ?? 0) + Number(p.paid_amount));
    }
  }

  // Pending = Person hat „Ich habe gezahlt" geklickt, Vorstrecker noch nicht
  // bestätigt. Wir wollen die Person NICHT erneut mahnen — sie sieht in der
  // App ⏳ pending und wartet auf den Vorstrecker.
  const pendingByTranchePerson = new Set<string>();
  for (const r of pendingRows ?? []) {
    if (r.tranche_id && r.person_id) {
      pendingByTranchePerson.add(`${r.tranche_id}::${r.person_id}`);
    }
  }

  // Wie viel hat der Vorstrecker schon an den Vercharterer überwiesen — pro Tranche?
  const paidToAgencyByTranche = new Map<string, number>();
  for (const e of charterExpenses ?? []) {
    if (e.tranche_id) {
      paidToAgencyByTranche.set(
        e.tranche_id,
        (paidToAgencyByTranche.get(e.tranche_id) ?? 0) + Number(e.amount),
      );
    }
  }

  const alreadySent = new Set<string>();
  for (const r of logRows ?? []) {
    alreadySent.add(`${r.tranche_id}::${r.person_id}::${r.reminder_type}`);
  }

  const jobs: ReminderJob[] = [];

  for (const t of tranches) {
    const trip = tripById.get(t.trip_id);
    if (!trip) continue;
    // Bereits abgelaufene Trips überspringen (Anzahlungs-Mahnung nach Törn macht keinen Sinn).
    if (trip.end_date && trip.end_date < todayIso) continue;

    const plan = planByTrip.get(t.trip_id);
    if (!plan) continue;
    const advancerId = plan.advancer_person_id ?? trip.skipper_id;

    // Wie viele Tage sind es noch bis zur Charterfrist?
    const daysToCharter = signedDaysUntil(todayIso, t.due_date);

    // advancer_3d: ab 3 Tage vor Charterfrist UND nur wenn er dem Vercharterer noch was schuldet
    if (daysToCharter <= REMINDER_DAYS_BEFORE) {
      // Gesamt-basiert: nur mahnen, solange der Vorstrecker dem Vercharterer
      // INSGESAMT noch etwas schuldet (Überzahlung einer Tranche deckt eine
      // andere) — sonst Mahnung trotz summenmäßig vollständig beglichenem Charter.
      const sollTotal = Number(plan.total_amount);
      const paidTotal = tranches
        .filter((x) => x.trip_id === t.trip_id)
        .reduce((s, x) => s + (paidToAgencyByTranche.get(x.id) ?? 0), 0);
      const remainingTotal = sollTotal - paidTotal;
      const key = `${t.id}::${advancerId}::advancer_3d`;
      if (remainingTotal > FLOAT_TOL && !alreadySent.has(key)) {
        jobs.push({
          trancheId: t.id,
          tripId: t.trip_id,
          personId: advancerId,
          type: "advancer_3d",
          trancheLabel: t.label,
          tripName: trip.name,
          amount: remainingTotal,
          dueDate: t.due_date,
        });
      }
    }

    // crew_3d: ab 6 Tage vor Charterfrist (= 3 Tage vor Crewfrist).
    // Crew, deren Soll > 0 ist und die weder voll bezahlt noch pending sind.
    if (daysToCharter <= CREW_WINDOW_MAX_DAYS) {
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
        if (trancheSoll - paid <= FLOAT_TOL) continue;
        // Pending = Person hat selbst gemeldet → keinen Reminder mehr.
        if (pendingByTranchePerson.has(`${t.id}::${personId}`)) continue;
        const key = `${t.id}::${personId}::crew_3d`;
        if (alreadySent.has(key)) continue;
        jobs.push({
          trancheId: t.id,
          tripId: t.trip_id,
          personId,
          type: "crew_3d",
          trancheLabel: t.label,
          tripName: trip.name,
          amount: trancheSoll - paid,
          dueDate: t.due_date,
        });
      }
    }
  }

  // `skipped` = Job war schlicht nicht (mehr) zutreffend (keine Mail-Adresse,
  // keine offenen Tranchen, Trip/Person nicht mehr vorhanden) — kein Fehler.
  // `failed` = etwas ist TATSÄCHLICH schiefgegangen (Mail-Zustellung, der
  // Dedup-Log-Insert oder eine geworfene Exception) — analog zum Purge-Cron,
  // der `purged`/`failed` getrennt zurückgibt (Fund 3, PR 6). Vorher landete
  // ein echter Fehlschlag nur in `skipped` + einem weichen `console.error`,
  // ohne dass ein Coolify-„Recent executions"-Blick erkennen konnte, ob in
  // der Nacht tatsächlich etwas schiefging.
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ job: ReminderJob; message: string; kind: "skipped" | "failed" }> = [];

  for (const job of jobs) {
    try {
      const result = await sendPrepaymentReminderMail({
        tripId: job.tripId,
        personId: job.personId,
        trancheId: job.trancheId,
        isAutomated: true,
      });
      if (!result.ok) {
        if (result.reason === "send_failed") {
          failed++;
          console.error("[bordkasse:cron] mail send failed:", { job, message: result.message });
          // Kein SMTP-Rohtext ins JSON (nennt oft die Adresse, Review P4).
          errors.push({ job, message: safeMailErrorMessage({}), kind: "failed" });
        } else {
          skipped++;
          errors.push({ job, message: result.message, kind: "skipped" });
        }
        continue;
      }
      const { error: logErr } = await supabase.from("prepayment_reminder_log").insert({
        trip_id: job.tripId,
        tranche_id: job.trancheId,
        person_id: job.personId,
        reminder_type: job.type,
      });
      if (logErr) {
        if (logErr.code === "23505") {
          // Unique-Violation = parallele Cron-Instanz hat schon gelogged — egal.
          console.warn("[bordkasse:cron] log insert (dedupe, parallel run):", logErr.message);
        } else {
          // Mail ist raus, aber der Dedup-Eintrag fehlt → der nächste Lauf
          // würde dieselbe Person erneut mahnen. Kein Grund, sent-- zu
          // machen (die Mail kam an), aber sichtbar als failed melden.
          failed++;
          console.error("[bordkasse:cron] log insert failed:", { job, message: logErr.message });
          errors.push({ job, message: `Dedup-Log fehlgeschlagen: ${logErr.message}`, kind: "failed" });
        }
      }

      // Push zusätzlich zur Mail (additiv, wirft nie). Kein Actor → keine
      // Exclusion; der Dedup-Log oben deckt beide Kanäle gemeinsam ab, sodass
      // weder Mail noch Push erneut rausgehen.
      await sendPushToPersons(
        supabase,
        [job.personId],
        job.type === "crew_3d"
          ? prepaymentReminderPush({
              trancheLabel: job.trancheLabel,
              amount: job.amount,
              tripName: job.tripName,
              tripId: job.tripId,
              trancheId: job.trancheId,
              due: formatDeDate(toCrewDueDate(job.dueDate)),
            })
          : charterReminderPush({
              tripName: job.tripName,
              tripId: job.tripId,
              trancheId: job.trancheId,
              amount: job.amount,
              due: formatDeDate(job.dueDate),
            }),
      );

      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[bordkasse:cron] job failed:", { job, msg });
      errors.push({ job, message: "Unerwarteter Fehler beim Versand", kind: "failed" });
      failed++;
    }
  }

  return {
    processed: jobs.length,
    sent,
    skipped,
    failed,
    errors: errors.map((e) => ({ type: e.job.type, message: e.message, kind: e.kind })),
  };
}

type PartResult = ItemReminderRunResult;

const summarize = (r: PartResult) => ({ processed: r.processed, sent: r.sent, skipped: r.skipped, failed: r.failed });

/** Antwort-JSON: Summen über Tranchen + Posten, plus Aufschlüsselung. */
function combine(tranches: PartResult, items: PartResult) {
  return {
    ok: true,
    processed: tranches.processed + items.processed,
    sent: tranches.sent + items.sent,
    skipped: tranches.skipped + items.skipped,
    failed: tranches.failed + items.failed,
    tranches: summarize(tranches),
    items: summarize(items),
    errors: [...tranches.errors, ...items.errors],
    ranAt: new Date().toISOString(),
  };
}

/**
 * Vorzeichenbehaftete, EXKLUSIVE Tagesdifferenz zwischen zwei ISO-Dates (beide
 * UTC-anchored): gleiches Datum → 0, Vergangenheit → negativ.
 *
 * ⚠️ BEWUSST NICHT `lib/utils.ts:daysBetween` — jenes ist INKLUSIV (`+1`) und
 * auf ≥0 geclampt (Anwesenheitstage). Ein naives „Dedup" würde jedes Reminder-
 * Fenster um einen Tag verschieben und überfällige (negative) Fristen verlieren.
 * Daher ein eigener, klar benannter Helfer statt des kollidierenden Namens.
 */
function signedDaysUntil(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}
