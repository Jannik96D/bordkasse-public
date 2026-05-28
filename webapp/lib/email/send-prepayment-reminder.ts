/**
 * Versand der Anzahlungs-Erinnerungs-Mail an eine einzelne Crew-Person.
 * Wird vom Skipper manuell über den 🔔-Button in der Matrix ausgelöst.
 *
 * Spec: docs/prepayments.md §Erinnerungsmail
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/send";
import { renderPrepaymentReminderMail, type ReminderTrancheItem } from "@/lib/email/prepayment-reminder-template";

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export async function sendPrepaymentReminderMail(params: {
  tripId: string;
  personId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = createAdminClient();

  // Person + E-Mail
  const [{ data: person }, { data: priv }] = await Promise.all([
    supabase.from("persons").select("display_name").eq("id", params.personId).maybeSingle(),
    supabase.from("persons_private").select("email").eq("person_id", params.personId).maybeSingle(),
  ]);
  if (!person) return { ok: false, message: "Person nicht gefunden." };
  if (!priv?.email) return { ok: false, message: "Diese Person hat keine E-Mail-Adresse hinterlegt." };

  // Trip + Plan
  const [{ data: trip }, { data: plan }, { data: skipperRow }] = await Promise.all([
    supabase.from("trips").select("name, skipper_id").eq("id", params.tripId).maybeSingle(),
    supabase.from("prepayment_plan").select("wero_id").eq("trip_id", params.tripId).maybeSingle(),
    supabase.from("trips").select("skipper_id, persons!trips_skipper_id_fkey(display_name)").eq("id", params.tripId).maybeSingle(),
  ]);
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };

  const skipperRel = (skipperRow as unknown as { persons: { display_name: string } | { display_name: string }[] } | null)?.persons;
  const skipperFlat = Array.isArray(skipperRel) ? skipperRel[0] : skipperRel;
  const skipperName = skipperFlat?.display_name ?? "Der Skipper";

  // Soll + Tranchen + bereits gezahlt
  const [{ data: obl }, { data: tranches }, { data: paymentRows }] = await Promise.all([
    supabase.from("prepayment_obligations").select("total_amount").eq("trip_id", params.tripId).eq("person_id", params.personId).maybeSingle(),
    supabase.from("prepayment_tranches").select("id, due_date, label, percent, wero_request_link").eq("trip_id", params.tripId).order("sort_order").order("due_date"),
    supabase.from("v_prepayment_payments").select("tranche_id, paid_amount").eq("trip_id", params.tripId).eq("person_id", params.personId),
  ]);

  const totalSoll = Number(obl?.total_amount ?? 0);
  const paidByTranche = new Map<string, number>();
  for (const r of paymentRows ?? []) {
    if (r.tranche_id) paidByTranche.set(r.tranche_id, Number(r.paid_amount));
  }

  const openTranches: ReminderTrancheItem[] = [];
  for (const t of tranches ?? []) {
    const trancheSoll = (totalSoll * Number(t.percent)) / 100;
    const paid = paidByTranche.get(t.id) ?? 0;
    const open = trancheSoll - paid;
    if (open > 0.005) {
      openTranches.push({
        label: t.label,
        due_date: formatDeDate(t.due_date),
        amount_due: round2(open),
        amount_total: round2(trancheSoll),
        wero_request_link: t.wero_request_link,
      });
    }
  }

  if (openTranches.length === 0) {
    return { ok: false, message: "Diese Person hat keine offenen Tranchen." };
  }

  const mail = renderPrepaymentReminderMail({
    recipientName: person.display_name,
    tripName: trip.name,
    tranches: openTranches,
    weroId: plan?.wero_id ?? null,
    skipperName,
    appUrl: `${SITE_URL}/trips/${params.tripId}/prepayments`,
  });

  const result = await sendMail({ to: priv.email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true };
}

function formatDeDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
