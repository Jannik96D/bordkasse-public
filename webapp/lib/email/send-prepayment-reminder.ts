/**
 * Versand von Anzahlungs-Erinnerungs-Mails.
 *
 * Zwei Pfade:
 *   1. Crew-Pfad      → persönliche Tranchen-Liste mit Wero-Hinweis
 *                       (Empfänger ≠ Vorstrecker).
 *   2. Vorstrecker-Pfad → Charter-Übersicht (Soll Agentur / Crew-Eingänge /
 *                         schon überwiesen / noch offen) pro Tranche.
 *                         Wird auch vom Cron benutzt.
 *
 * Beide Pfade teilen sich die Trip-/Plan-/Tranchen-Daten — wir laden sie
 * einmal und routen dann zum jeweiligen Builder.
 *
 * Spec: docs/prepayments.md §Erinnerungsmail
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/send";
import {
  renderPrepaymentReminderMail,
  type ReminderTrancheItem,
} from "@/lib/email/prepayment-reminder-template";
import {
  renderCharterReminderMail,
  type CharterReminderTranche,
} from "@/lib/email/charter-reminder-template";
import { toCrewDueDate } from "@/lib/prepayments/dates";

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

type AnyResult = { ok: true } | { ok: false; message: string };

/**
 * Haupt-Einstiegspunkt — leitet automatisch ans richtige Template um.
 * Wenn `personId === advancerPersonId`, schickt die Charter-Reminder-Mail,
 * sonst die klassische Crew-Reminder-Mail.
 */
export async function sendPrepaymentReminderMail(params: {
  tripId: string;
  personId: string;
  /** true = vom Cron getriggert (Wortlaut "Anstehend"), false = manuell. */
  isAutomated?: boolean;
  /** Optional: nur diese Tranche im Reminder behandeln (Cron-Pfad). */
  trancheId?: string;
}): Promise<AnyResult> {
  const supabase = createAdminClient();

  const [{ data: trip }, { data: plan }] = await Promise.all([
    supabase.from("trips").select("name, skipper_id").eq("id", params.tripId).maybeSingle(),
    supabase
      .from("prepayment_plan")
      .select("wero_id, advancer_person_id, total_amount")
      .eq("trip_id", params.tripId)
      .maybeSingle(),
  ]);
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  if (!plan) return { ok: false, message: "Kein Anzahlungs-Plan vorhanden." };

  const advancerPersonId = plan.advancer_person_id ?? trip.skipper_id;
  const isAdvancerRecipient = params.personId === advancerPersonId;

  if (isAdvancerRecipient) {
    return sendCharterReminder(supabase, {
      tripId: params.tripId,
      tripName: trip.name,
      advancerPersonId,
      totalAmount: Number(plan.total_amount ?? 0),
      isAutomated: params.isAutomated ?? false,
      trancheId: params.trancheId,
    });
  }
  return sendCrewReminder(supabase, {
    tripId: params.tripId,
    tripName: trip.name,
    personId: params.personId,
    weroId: plan.wero_id ?? null,
    advancerPersonId,
    trancheId: params.trancheId,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Crew-Reminder (klassische Tranchen-Liste)
// ────────────────────────────────────────────────────────────────────────

async function sendCrewReminder(
  supabase: SupabaseAdmin,
  args: {
    tripId: string;
    tripName: string;
    personId: string;
    weroId: string | null;
    advancerPersonId: string;
    /** Wenn gesetzt, nur diese Tranche in die Mail packen (Cron-Pfad). */
    trancheId?: string;
  },
): Promise<AnyResult> {
  const [{ data: person }, { data: priv }, { data: advancer }] = await Promise.all([
    supabase.from("persons").select("display_name").eq("id", args.personId).maybeSingle(),
    supabase.from("persons_private").select("email").eq("person_id", args.personId).maybeSingle(),
    supabase.from("persons").select("display_name").eq("id", args.advancerPersonId).maybeSingle(),
  ]);
  if (!person) return { ok: false, message: "Person nicht gefunden." };
  if (!priv?.email) return { ok: false, message: "Diese Person hat keine E-Mail-Adresse hinterlegt." };

  const advancerName = advancer?.display_name ?? "der Skipper";

  const [{ data: obl }, { data: tranches }, { data: paymentRows }] = await Promise.all([
    supabase
      .from("prepayment_obligations")
      .select("total_amount")
      .eq("trip_id", args.tripId)
      .eq("person_id", args.personId)
      .maybeSingle(),
    supabase
      .from("prepayment_tranches")
      .select("id, due_date, label, percent")
      .eq("trip_id", args.tripId)
      .order("sort_order")
      .order("due_date"),
    supabase
      .from("v_prepayment_payments")
      .select("tranche_id, paid_amount")
      .eq("trip_id", args.tripId)
      .eq("person_id", args.personId),
  ]);

  const totalSoll = Number(obl?.total_amount ?? 0);
  const paidByTranche = new Map<string, number>();
  for (const r of paymentRows ?? []) {
    if (r.tranche_id) paidByTranche.set(r.tranche_id, Number(r.paid_amount));
  }

  const openTranches: ReminderTrancheItem[] = [];
  for (const t of tranches ?? []) {
    if (args.trancheId && t.id !== args.trancheId) continue;
    const trancheSoll = (totalSoll * Number(t.percent)) / 100;
    const paid = paidByTranche.get(t.id) ?? 0;
    const open = trancheSoll - paid;
    if (open > 0.005) {
      openTranches.push({
        label: t.label,
        due_date: formatDeDate(toCrewDueDate(t.due_date)),
        amount_due: round2(open),
        amount_total: round2(trancheSoll),
      });
    }
  }

  if (openTranches.length === 0) {
    return { ok: false, message: "Diese Person hat keine offenen Tranchen." };
  }

  const mail = renderPrepaymentReminderMail({
    recipientName: person.display_name,
    tripName: args.tripName,
    tranches: openTranches,
    weroId: args.weroId,
    advancerName,
    appUrl: `${SITE_URL}/trips/${args.tripId}/prepayments`,
  });

  const result = await sendMail({ to: priv.email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────
// Charter-Reminder (Vorstrecker-Sicht)
// ────────────────────────────────────────────────────────────────────────

async function sendCharterReminder(
  supabase: SupabaseAdmin,
  args: {
    tripId: string;
    tripName: string;
    advancerPersonId: string;
    totalAmount: number;
    isAutomated: boolean;
    /** Wenn gesetzt, nur diese Tranche in der Mail (Cron-Pfad). */
    trancheId?: string;
  },
): Promise<AnyResult> {
  const [{ data: person }, { data: priv }] = await Promise.all([
    supabase.from("persons").select("display_name").eq("id", args.advancerPersonId).maybeSingle(),
    supabase
      .from("persons_private")
      .select("email")
      .eq("person_id", args.advancerPersonId)
      .maybeSingle(),
  ]);
  if (!person) return { ok: false, message: "Vorstrecker nicht gefunden." };
  if (!priv?.email)
    return { ok: false, message: "Vorstrecker hat keine E-Mail-Adresse hinterlegt." };

  // Tranchen laden (alle oder gefiltert auf eine).
  const { data: tranches } = await supabase
    .from("prepayment_tranches")
    .select("id, due_date, label, percent")
    .eq("trip_id", args.tripId)
    .order("sort_order")
    .order("due_date");

  const relevant = (tranches ?? []).filter((t) => !args.trancheId || t.id === args.trancheId);
  if (relevant.length === 0) {
    return { ok: false, message: "Keine Tranchen vorhanden." };
  }

  // Σ Crew-Beiträge pro Tranche (alles, was bei dir reingekommen ist —
  // bestätigt + pending zählen wir hier mit, weil der Vorstrecker eh
  // hingehen muss).
  const { data: paymentRows } = await supabase
    .from("v_prepayment_payments")
    .select("tranche_id, paid_amount")
    .eq("trip_id", args.tripId);
  const crewPaidByTranche = new Map<string, number>();
  for (const r of paymentRows ?? []) {
    if (r.tranche_id) {
      crewPaidByTranche.set(
        r.tranche_id,
        (crewPaidByTranche.get(r.tranche_id) ?? 0) + Number(r.paid_amount),
      );
    }
  }

  // Σ Soll pro Tranche aus prepayment_obligations × percent
  const { data: obls } = await supabase
    .from("prepayment_obligations")
    .select("total_amount")
    .eq("trip_id", args.tripId);
  const crewSollTotal = (obls ?? []).reduce((s, o) => s + Number(o.total_amount), 0);

  // Σ schon-an-Agentur-überwiesen pro Tranche (expense mit dieser tranche_id).
  const { data: expenseRows } = await supabase
    .from("transactions")
    .select("tranche_id, amount")
    .eq("trip_id", args.tripId)
    .eq("type", "expense")
    .is("deleted_at", null)
    .not("tranche_id", "is", null);
  const paidToAgencyByTranche = new Map<string, number>();
  for (const r of expenseRows ?? []) {
    if (r.tranche_id) {
      paidToAgencyByTranche.set(
        r.tranche_id,
        (paidToAgencyByTranche.get(r.tranche_id) ?? 0) + Number(r.amount),
      );
    }
  }

  const trancheItems: CharterReminderTranche[] = relevant.map((t) => {
    const pct = Number(t.percent);
    const sollAgency = round2((args.totalAmount * pct) / 100);
    const crewTotalDue = round2((crewSollTotal * pct) / 100);
    const crewPaid = round2(crewPaidByTranche.get(t.id) ?? 0);
    const paidAgency = round2(paidToAgencyByTranche.get(t.id) ?? 0);
    return {
      label: t.label,
      charter_due_date: formatDeDate(t.due_date),
      soll_to_agency: sollAgency,
      crew_paid_to_advancer: crewPaid,
      crew_total_due: crewTotalDue,
      paid_to_agency: paidAgency,
      remaining_to_agency: round2(sollAgency - paidAgency),
    };
  });

  const mail = renderCharterReminderMail({
    recipientName: person.display_name,
    tripName: args.tripName,
    tranches: trancheItems,
    appUrl: `${SITE_URL}/trips/${args.tripId}/prepayments`,
    isAutomated: args.isAutomated,
  });

  const result = await sendMail({
    to: priv.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true };
}

function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
